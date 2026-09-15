/**
 * A stable event target whose method calls resolve to the currently mounted controller.
 * Listeners are installed once. A method already running retains its concrete receiver,
 * so an asynchronous save cannot accidentally resume against another workspace.
 * @template {object} T
 */
export class SessionBinding {
    /** @param {T} target Initial controller or service. */
    constructor(target) {
        this.target = target;
        this.proxy = /** @type {T} */ (new Proxy(/** @type {object} */ (target), {
            get: (_target, key) => {
                const value = Reflect.get(/** @type {object} */ (this.target), key);
                return typeof value === "function" ? value.bind(this.target) : value;
            },
            set: (_target, key, value) => Reflect.set(/** @type {object} */ (this.target), key, value),
        }));
    }
}

/**
 * Records constructor dependencies and installs shared-control listeners through a relay.
 * Secondary workspace controllers use the same elements without adding duplicate listeners.
 * @template {{bindEvents: () => void}} T
 * @param {T} controller Concrete view that owns its editor state.
 * @param {object} options Original constructor dependencies.
 * @returns {SessionBinding<T>} Relay used by the shell when a workspace is mounted.
 */
export function bindSessionEvents(controller, options) {
    const binding = new SessionBinding(controller);
    if (options["bindEvents"] !== false) controller.bindEvents.call(binding.proxy);
    return binding;
}
