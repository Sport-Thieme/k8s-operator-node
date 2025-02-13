import * as FS from 'fs';
import * as https from 'https';
import * as Async from 'async';
import getDebugLogger, { Debugger } from 'debug';
import * as k8s from '@kubernetes/client-node';
import Axios, { AxiosRequestConfig, Method as HttpMethod } from 'axios';
import {
    KubernetesObject,
    loadYaml,
    V1CustomResourceDefinition,
    V1CustomResourceDefinitionVersion,
    Watch,
} from '@kubernetes/client-node';

/**
 * Logger interface.
 */
export interface OperatorLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

class NullLogger implements OperatorLogger {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public debug(message: string): void {
        // no-op
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public info(message: string): void {
        // no-op
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public warn(message: string): void {
        // no-op
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public error(message: string): void {
        // no-op
    }
}

/**
 * The resource event type.
 */
export enum ResourceEventType {
    Added = 'ADDED',
    Modified = 'MODIFIED',
    Deleted = 'DELETED',
}

/**
 * An event on a Kubernetes resource.
 */
export interface ResourceEvent<
    Spec extends Record<string, unknown> | unknown = unknown,
    Status extends string | Record<string, unknown> | undefined | unknown = unknown
> {
    meta: ResourceMeta;
    type: ResourceEventType;
    object: KubernetesObject & {
        status: Status;
        spec: Spec;
    };
}

/**
 * Some meta information on the resource.
 */
export interface ResourceMeta {
    name: string;
    namespace?: string;
    id: string;
    resourceVersion: string;
    apiVersion: string;
    kind: string;
}

export class ResourceMetaImpl implements ResourceMeta {
    public static createWithId(id: string, object: KubernetesObject): ResourceMeta {
        return new ResourceMetaImpl(id, object);
    }

    public static createWithPlural(plural: string, object: KubernetesObject): ResourceMeta {
        return new ResourceMetaImpl(`${plural}.${object.apiVersion}`, object);
    }

    public id: string;
    public name: string;
    public namespace?: string;
    public resourceVersion: string;
    public apiVersion: string;
    public kind: string;

    private constructor(id: string, object: KubernetesObject) {
        if (!object.metadata?.name || !object.metadata?.resourceVersion || !object.apiVersion || !object.kind) {
            throw Error(`Malformed event object for '${id}'`);
        }
        this.id = id;
        this.name = object.metadata.name;
        this.namespace = object.metadata.namespace;
        this.resourceVersion = object.metadata.resourceVersion;
        this.apiVersion = object.apiVersion;
        this.kind = object.kind;
    }
}

/**
 * Base class for an operator.
 */
export default abstract class Operator {
    protected kubeConfig: k8s.KubeConfig;
    protected k8sApi: k8s.CoreV1Api;

    protected debugger: Debugger;
    protected logger: OperatorLogger;
    private resourcePathBuilders: Record<string, (meta: ResourceMeta) => string> = {};
    private watchRequests: Record<string, { abort(): void }> = {};
    private eventQueue: Async.QueueObject<{
        event: ResourceEvent;
        onEvent: (event: ResourceEvent) => Promise<void>;
    }>;

    /**
     * Constructs an operator.
     */
    constructor(logger?: OperatorLogger) {
        this.kubeConfig = new k8s.KubeConfig();
        this.kubeConfig.loadFromDefault();
        this.k8sApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
        this.debugger = getDebugLogger('operator');
        this.logger = logger || new NullLogger();

        // Use an async queue to make sure we treat each incoming event sequentially using async/await
        this.eventQueue = Async.queue<{
            onEvent: (event: ResourceEvent) => Promise<void>;
            event: ResourceEvent;
        }>(async (args) => await args.onEvent(args.event));
    }

    /**
     * Run the operator, typically called from main().
     */
    public async start(): Promise<void> {
        this.debugger('Starting...');
        await this.init();
    }

    public stop(): void {
        this.debugger('Stopping...');
        for (const req of Object.values(this.watchRequests)) {
            req.abort();
        }
    }

    /**
     * Initialize the operator, add your resource watchers here.
     */
    protected abstract init(): Promise<void>;

    /**
     * Register a custom resource defintion.
     * @param crdFile The path to the custom resource definition's YAML file
     */
    protected async registerCustomResourceDefinition(crdFile: string): Promise<{
        group: string;
        versions: V1CustomResourceDefinitionVersion[];
        plural: string;
    }> {
        const crd = loadYaml(FS.readFileSync(crdFile, 'utf8')) as V1CustomResourceDefinition;
        try {
            const apiVersion = crd.apiVersion as string;
            if (!apiVersion || !apiVersion.startsWith('apiextensions.k8s.io/')) {
                throw new Error("Invalid CRD yaml (expected 'apiextensions.k8s.io')");
            }
            await this.kubeConfig.makeApiClient(k8s.ApiextensionsV1Api).createCustomResourceDefinition(crd);
            this.logger.info(`registered custom resource definition '${crd.metadata?.name}'`);
        } catch (err) {
            // API returns a 409 Conflict if CRD already exists.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((err as any).response?.statusCode !== 409) {
                throw err;
            }
        }
        return {
            group: crd.spec.group,
            versions: crd.spec.versions,
            plural: crd.spec.names.plural,
        };
    }

    /**
     * Get uri to the API for your custom resource.
     * @param group The group of the custom resource
     * @param version The version of the custom resource
     * @param plural The plural name of the custom resource
     * @param namespace Optional namespace to include in the uri
     */
    public getCustomResourceApiUri(group: string, version: string, plural: string, namespace?: string): string {
        let path = group ? `/apis/${group}/${version}/` : `/api/${version}/`;
        if (namespace) {
            path += `namespaces/${namespace}/`;
        }
        path += plural;
        return this.k8sApi.basePath + path;
    }

    /**
     * Watch a Kubernetes resource.
     * @param group The group of the resource or an empty string for core resources
     * @param version The version of the resource
     * @param plural The plural name of the resource
     * @param onEvent The async callback for added, modified or deleted events on the resource
     * @param namespace The namespace of the resource (optional)
     */
    public async watchResource(
        group: string,
        version: string,
        plural: string,
        onEvent: (event: ResourceEvent) => Promise<void>,
        namespace?: string
    ): Promise<void> {
        const apiVersion = group ? `${group}/${version}` : `${version}`;
        const id = `${plural}.${apiVersion}`;

        this.resourcePathBuilders[id] = (meta: ResourceMeta): string =>
            this.getCustomResourceApiUri(group, version, plural, meta.namespace);

        //
        // Create "infinite" watch so we automatically recover in case the stream stops or gives an error.
        //
        let uri = group ? `/apis/${group}/${version}/` : `/api/${version}/`;
        if (namespace) {
            uri += `namespaces/${namespace}/`;
        }
        uri += plural;

        const watch = new Watch(this.kubeConfig);

        const startWatch = (): Promise<void> =>
            watch
                .watch(
                    uri,
                    {},
                    (phase, obj) =>
                        this.eventQueue.push({
                            event: {
                                meta: ResourceMetaImpl.createWithPlural(plural, obj),
                                object: obj,
                                type: phase as ResourceEventType,
                            },
                            onEvent,
                        }),
                    (err) => {
                        if (err) {
                            this.logger.error(`watch on resource ${id} failed: ${this.errorToJson(err)}`);
                            process.exit(1);
                        }
                        this.logger.debug(`restarting watch on resource ${id}`);
                        setTimeout(startWatch, 200);
                    }
                )
                .catch((reason) => {
                    this.logger.error(`watch on resource ${id} failed: ${this.errorToJson(reason)}`);
                    process.exit(1);
                })
                .then((req) => (this.watchRequests[id] = req));

        await startWatch();

        this.logger.info(`watching resource ${id}`);
    }

    /**
     * Set the status subresource of a custom resource (if it has one defined).
     * @param meta The resource to update
     * @param status The status body to set
     */
    public async setResourceStatus(meta: ResourceMeta, status: unknown): Promise<ResourceMeta | null> {
        this.debugger(`Setting status of ${meta.namespace ?? 'default'}/${meta.name}...`);
        return await this.resourceStatusRequest('PUT', meta, status);
    }

    /**
     * Patch the status subresource of a custom resource (if it has one defined).
     * @param meta The resource to update
     * @param status The status body to set in JSON Merge Patch format (https://tools.ietf.org/html/rfc7386)
     */
    public async patchResourceStatus(meta: ResourceMeta, status: unknown): Promise<ResourceMeta | null> {
        this.debugger(`Patching status of ${meta.namespace ?? 'default'}/${meta.name}...`);
        return await this.resourceStatusRequest('PATCH', meta, status);
    }

    /**
     * Handle deletion of resource using a unique finalizer. Call this when you receive an added or modified event.
     *
     * If the resource doesn't have the finalizer set yet, it will be added. If the finalizer is set and the resource
     * is marked for deletion by Kubernetes your 'deleteAction' action will be called and the finalizer will be removed.
     * @param event The added or modified event.
     * @param finalizer Your unique finalizer string
     * @param deleteAction An async action that will be called before your resource is deleted.
     * @returns True if no further action is needed, false if you still need to process the added or modified event yourself.
     */
    public async handleResourceFinalizer(
        event: ResourceEvent,
        finalizer: string,
        deleteAction: (event: ResourceEvent) => Promise<void>
    ): Promise<boolean> {
        this.debugger(`Handling finalizer ${finalizer} for ${event.meta.namespace ?? 'default'}/${event.meta.name}...`);
        const metadata = event.object.metadata;
        if (!metadata || (event.type !== ResourceEventType.Added && event.type !== ResourceEventType.Modified)) {
            this.debugger(`No metadata found in ${event.type} event, or event is not an added or modified.`);
            return false;
        }
        if (!metadata.deletionTimestamp && (!metadata.finalizers || !metadata.finalizers.includes(finalizer))) {
            // Make sure our finalizer is added when the resource is first created.
            const finalizers = metadata.finalizers ?? [];
            finalizers.push(finalizer);
            await this.setResourceFinalizers(event.meta, finalizers);
            return true;
        } else if (metadata.deletionTimestamp) {
            if (metadata.finalizers && metadata.finalizers.includes(finalizer)) {
                // Resource is marked for deletion with our finalizer still set. So run the delete action
                // and clear the finalizer, so the resource will actually be deleted by Kubernetes.
                await deleteAction(event);
                const finalizers = metadata.finalizers.filter((f) => f !== finalizer);
                await this.setResourceFinalizers(event.meta, finalizers);
            }
            // Resource is marked for deletion, so don't process it further.
            return true;
        }
        return false;
    }

    /**
     * Set (or clear) the finalizers of a resource.
     * @param meta The resource to update
     * @param finalizers The array of finalizers for this resource
     */
    public async setResourceFinalizers(meta: ResourceMeta, finalizers: string[]): Promise<void> {
        this.debugger(`Setting finalizers of ${meta.namespace ?? 'default'}/${meta.name}...`);
        const request: AxiosRequestConfig = {
            method: 'PATCH',
            url: `${this.resourcePathBuilders[meta.id](meta)}/${meta.name}`,
            data: {
                metadata: {
                    finalizers,
                },
            },
            headers: {
                'Content-Type': 'application/merge-patch+json',
            },
        };

        await this.applyAxiosKubeConfigAuth(request);

        await Axios.request(request).catch((error) => {
            if (error) {
                this.logger.error(this.errorToJson(error));
                return;
            }
        });
    }

    /**
     * Apply authentication to an axios request config.
     * @param request the axios request config
     */
    protected async applyAxiosKubeConfigAuth(request: AxiosRequestConfig): Promise<void> {
        const opts: https.RequestOptions = {};
        await this.kubeConfig.applytoHTTPSOptions(opts);
        if (opts.headers?.Authorization) {
            request.headers = request.headers ?? {};
            request.headers.Authorization = opts.headers.Authorization as string;
        }
        if (opts.auth) {
            const userPassword = opts.auth.split(':');
            request.auth = {
                username: userPassword[0],
                password: userPassword[1],
            };
        }
        if (opts.ca || opts.cert || opts.key) {
            request.httpsAgent = new https.Agent({
                ca: opts.ca,
                cert: opts.cert,
                key: opts.key,
            });
        }
    }

    private async resourceStatusRequest(
        method: HttpMethod,
        meta: ResourceMeta,
        status: unknown
    ): Promise<ResourceMeta | null> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = {
            apiVersion: meta.apiVersion,
            kind: meta.kind,
            metadata: {
                name: meta.name,
                resourceVersion: meta.resourceVersion,
            },
            status,
        };
        if (meta.namespace) {
            body.metadata.namespace = meta.namespace;
        }
        const request: AxiosRequestConfig = {
            method,
            url: this.resourcePathBuilders[meta.id](meta) + `/${meta.name}/status`,
            data: body,
        };
        if (method === 'patch' || method === 'PATCH') {
            request.headers = {
                'Content-Type': 'application/merge-patch+json',
            };
        }
        await this.applyAxiosKubeConfigAuth(request);
        try {
            const response = await Axios.request<KubernetesObject>(request);
            return response ? ResourceMetaImpl.createWithId(meta.id, response.data) : null;
        } catch (err) {
            this.logger.error(this.errorToJson(err));
            return null;
        }
    }

    private errorToJson(err: unknown): string {
        if (typeof err === 'string') {
            return err;
        } else if ((err as Error)?.message && (err as Error).stack) {
            return JSON.stringify(err, ['name', 'message', 'stack']);
        }
        return JSON.stringify(err);
    }
}
