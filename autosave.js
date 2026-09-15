/**
 * Debounces repository saves without tying deadlines to UI renders or browser timer accuracy.
 * The owner supplies dirty/in-flight state; only explicit edits restart an existing deadline.
 */
export class AutosaveTimer {
    /**
     * Creates an idle scheduler. Nothing runs until the owner reports pending changes.
     * @param {() => Promise<void>} save Shared save operation, including its error reporting.
     * @param {() => void} render Refreshes the indicator and supplies updated state via update().
     * @param {(error: unknown) => void} onError Reports unexpected save failures without losing the retry.
     * @param {number} [delay] Idle/retry interval in milliseconds.
     */
    constructor(save, render, onError, delay = 60000) {
        this.save = save;
        this.render = render;
        this.onError = onError;
        this.delay = delay;
        this.deadline = 0;
        this.pending = false;
        this.saving = false;
        this.generation = 0;
        /** @type {ReturnType<typeof setTimeout> | null} */
        this.timer = null;
    }

    /** @returns {number} Rounded-up seconds until the next attempt, not a decrementing tick counter. */
    get seconds() { return Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)); }

    /**
     * Reconciles persisted state without treating navigation or save completion as another edit.
     * Restored drafts and failed attempts receive a fresh deadline when none exists.
     * @param {boolean} pending Whether any eligible workspace has unsaved changes.
     * @param {boolean} saving Whether a save is already in flight.
     * @returns {void}
     */
    update(pending, saving) {
        this.pending = pending;
        this.saving = saving;
        if (!pending) this.deadline = 0;
        else if (!this.deadline && !saving) this.deadline = Date.now() + this.delay;
        this.schedule();
    }

    /** @returns {void} Restarts the idle interval after an applied edit, including undo/redo during a save. */
    edited() {
        this.deadline = this.pending ? Date.now() + this.delay : 0;
        this.schedule();
    }

    /** @returns {void} Consumes a deadline for a manual or automatic attempt; subsequent edits get a new one. */
    beginSave() {
        this.deadline = 0;
        this.clearTimer();
    }

    /** @returns {void} Cancels the wake-up without changing its logical deadline. */
    clearTimer() {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }

    /** @returns {void} Schedules only the next indicator update, never a second write while one is in flight. */
    schedule() {
        this.clearTimer();
        if (!this.pending || !this.deadline) return;
        const remaining = this.deadline - Date.now();
        if (remaining <= 0 && this.saving) return;
        this.timer = setTimeout(() => this.tick(), Math.min(1000, Math.max(0, remaining)));
    }

    /** @returns {void} Rechecks the wall-clock deadline, saving once or refreshing the remaining seconds. */
    tick() {
        this.timer = null;
        if (!this.pending) return;
        if (this.seconds || this.saving) {
            this.render();
            return;
        }
        const generation = this.generation;
        this.beginSave();
        void this.save().catch(this.onError).finally(() => {
            if (generation === this.generation) this.render();
        });
    }

    /** @returns {void} Invalidates pending wake-ups on logout so another login cannot inherit their deadline. */
    reset() {
        this.generation++;
        this.clearTimer();
        this.deadline = 0;
        this.pending = false;
        this.saving = false;
    }
}
