/**
 * نظام توجيه التفاعلات المركزي (Interaction Router)
 * يهدف هذا الملف ليكون النقطة الوحيدة لاستقبال التفاعلات وتوزيعها على الأنظمة
 */

class InteractionRouter {
    constructor() {
        this.handlers = [];
        this.defaultTimeoutMs = 65000;
        this.slowThresholdMs = 1000;
    }

    /**
     * تسجيل معالج لنظام معين
     * @param {string} prefix البادئة (مثل 'vac_', 'report_')
     * @param {Function} handlerFunction الدالة المعالجة
     */
    register(prefix, handlerFunction, options = {}) {
        const entry = {
            prefix,
            handler: handlerFunction,
            match: options.match || 'prefix',
            priority: Number.isFinite(options.priority) ? options.priority : 0,
            types: Array.isArray(options.types) ? options.types : null,
            name: options.name || prefix,
            timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : null
        };
        this.handlers.push(entry);
        this.handlers.sort((a, b) => b.priority - a.priority);
        console.log(`[InteractionRouter] تم تسجيل نظام: ${entry.name}`);
        return entry;
    }

    unregister(prefix, handlerFunction) {
        const before = this.handlers.length;
        this.handlers = this.handlers.filter(entry => !(entry.prefix === prefix && entry.handler === handlerFunction));
        return this.handlers.length !== before;
    }

    clear() {
        this.handlers = [];
    }

    _matchEntry(entry, customId) {
        if (entry.match === 'exact') {
            return customId === entry.prefix;
        }
        if (entry.match === 'regex' && entry.prefix instanceof RegExp) {
            return entry.prefix.test(customId);
        }
        return customId.startsWith(entry.prefix);
    }

    _typeAllowed(interaction, types) {
        if (!types || types.length === 0) return true;
        const checks = {
            button: 'isButton',
            modal: 'isModalSubmit',
            stringSelect: 'isStringSelectMenu',
            roleSelect: 'isRoleSelectMenu',
            userSelect: 'isUserSelectMenu',
            channelSelect: 'isChannelSelectMenu',
            mentionableSelect: 'isMentionableSelectMenu',
            anySelect: 'isAnySelectMenu',
            autocomplete: 'isAutocomplete'
        };
        return types.some(type => {
            const method = checks[type];
            return typeof interaction[method] === 'function' && interaction[method]();
        });
    }

    async _safeRespond(interaction, payload) {
        if (!interaction) return;
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ ...payload, ephemeral: true }).catch(() => {});
        } else {
            await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
        }
    }

    async _runWithTimeout(handlerPromise, timeoutMs) {
        if (!timeoutMs) return handlerPromise;
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error('ROUTER_HANDLER_TIMEOUT'));
            }, timeoutMs);
        });
        try {
            return await Promise.race([handlerPromise, timeoutPromise]);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * توجيه التفاعل للمعالج المناسب
     */
    async route(interaction, context = {}) {
        if (!interaction || !interaction.customId) return false;
        if (interaction.replied || interaction.deferred) return true;

        let matched = false;
        let consumed = false;
        for (const entry of this.handlers) {
            if (!this._matchEntry(entry, interaction.customId)) {
                continue;
            }
            if (!this._typeAllowed(interaction, entry.types)) {
                continue;
            }
            matched = true;
            const startedAt = Date.now();
            try {
                const timeoutMs = entry.timeoutMs || this.defaultTimeoutMs;
                const result = await this._runWithTimeout(entry.handler(interaction, context), timeoutMs);
                const duration = Date.now() - startedAt;
                if (duration >= this.slowThresholdMs) {
                    console.warn(`[InteractionRouter] المعالج بطيء (${duration}ms): ${entry.name}`);
                }
                if (result !== false) {
                    consumed = true;
                    break;
                }
            } catch (error) {
                console.error(`[InteractionRouter] خطأ في ${entry.name}:`, error);
                if (error.message === 'ROUTER_HANDLER_TIMEOUT') {
                    await this._safeRespond(interaction, { content: '❌ انتهت مهلة معالجة التفاعل.' });
                } else {
                    await this._safeRespond(interaction, { content: '❌ حدث خطأ أثناء معالجة التفاعل.' });
                }
                consumed = true;
                break;
            }
        }
        return matched && consumed;
    }
}

module.exports = new InteractionRouter();
