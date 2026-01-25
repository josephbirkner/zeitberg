/**
 * Safely returns a required element by id.
 * Throws immediately when the element is missing to avoid silent null usage.
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new (...args: any[]) => T} [ctor]
 * @returns {T}
 */
export function getRequiredElement(id, ctor) {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`Missing element #${id}`);
    }
    if (ctor && !(el instanceof ctor)) {
        const expected = /** @type {Function} */ (ctor).name || "expected type";
        throw new Error(`Element #${id} is not ${expected}`);
    }
    return /** @type {T} */ (el);
}

/**
 * Toggles element visibility using the hidden attribute.
 * Keeps layout logic centralized and avoids direct style mutations.
 * @param {HTMLElement} el
 * @param {boolean} isVisible
 * @returns {void}
 */
export function setVisible(el, isVisible) {
    el.hidden = !isVisible;
}

/**
 * Converts a value to a string, preserving empty strings.
 * Normalizes nullish values to an empty string for text content.
 * @param {unknown} value
 * @returns {string}
 */
export function safeText(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

/**
 * Formats a duration in seconds as H:MM.
 * Returns an em dash when the input is not a valid non-negative number.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        return "—";
    }
    const sign = seconds < 0 ? "-" : "";
    const abs = Math.abs(Math.round(seconds));
    const hours = Math.floor(abs / 3600);
    const minutes = Math.floor((abs % 3600) / 60);
    return `${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Parses a hex color string (#RRGGBB) into RGB components.
 * Returns null when the input is missing or not a valid hex color.
 * @param {string} value
 * @returns {{r: number, g: number, b: number} | null}
 */
export function parseHexColor(value) {
    const text = String(value || "").trim();
    const match = /^#([0-9a-f]{6})$/i.exec(text);
    if (!match) return null;
    const intVal = Number.parseInt(match[1], 16);
    return {
        r: (intVal >> 16) & 0xff,
        g: (intVal >> 8) & 0xff,
        b: intVal & 0xff,
    };
}

/**
 * Generates a deterministic hex color for a given key.
 * Used to seed project colors from existing entry names.
 * @param {string} value
 * @returns {string}
 */
export function hashColorHex(value) {
    const text = String(value || "").trim();
    if (!text) return "#7c5cff";

    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    const hue = Math.abs(hash) % 360;
    const rgb = hslToRgb(hue, 0.82, 0.55);
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * Converts an HSL color to RGB components.
 * Expects hue in degrees and saturation/lightness in 0..1.
 * @param {number} h
 * @param {number} s
 * @param {number} l
 * @returns {{r: number, g: number, b: number}}
 */
function hslToRgb(h, s, l) {
    const hue = ((Number(h) % 360) + 360) % 360;
    const sat = Math.max(0, Math.min(1, Number(s)));
    const lig = Math.max(0, Math.min(1, Number(l)));
    const c = (1 - Math.abs(2 * lig - 1)) * sat;
    const hh = hue / 60;
    const x = c * (1 - Math.abs((hh % 2) - 1));

    let r1 = 0;
    let g1 = 0;
    let b1 = 0;
    if (hh >= 0 && hh < 1) {
        r1 = c;
        g1 = x;
    } else if (hh >= 1 && hh < 2) {
        r1 = x;
        g1 = c;
    } else if (hh >= 2 && hh < 3) {
        g1 = c;
        b1 = x;
    } else if (hh >= 3 && hh < 4) {
        g1 = x;
        b1 = c;
    } else if (hh >= 4 && hh < 5) {
        r1 = x;
        b1 = c;
    } else {
        r1 = c;
        b1 = x;
    }

    const m = lig - c / 2;
    return {
        r: Math.round((r1 + m) * 255),
        g: Math.round((g1 + m) * 255),
        b: Math.round((b1 + m) * 255),
    };
}

/**
 * Formats an 8-bit value as a two-character hex string.
 * Keeps output stable for color serialization.
 * @param {number} value
 * @returns {string}
 */
function toHex(value) {
    const clamped = Math.max(0, Math.min(255, Number(value) || 0));
    return clamped.toString(16).padStart(2, "0");
}

/**
 * Returns true when the target is a form control or editable element.
 * Used to avoid hijacking keyboard shortcuts while typing in inputs.
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isEditableTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

/**
 * Deep clones a JSON-compatible value.
 * Falls back to JSON stringify/parse when structuredClone is unavailable.
 * @param {unknown} value
 * @returns {any}
 */
export function cloneJson(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

/**
 * Returns an ISO timestamp (UTC) without milliseconds.
 * Used for deterministic metadata in generated JSON files.
 * @returns {string}
 */
export function utcNowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Sorts object keys recursively for deterministic JSON output.
 * Leaves arrays in place while ensuring object key ordering is stable.
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map(sortJsonValue);
    }
    if (value && typeof value === "object" && value.constructor === Object) {
        const out = {};
        const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
        for (const key of keys) {
            out[key] = sortJsonValue(value[key]);
        }
        return out;
    }
    return value;
}

/**
 * Returns stable, pretty JSON output.
 * Normalizes key order and adds a trailing newline for diffs.
 * @param {unknown} value
 * @returns {string}
 */
export function jsonStringifySorted(value) {
    return JSON.stringify(sortJsonValue(value), null, 2) + "\n";
}

/**
 * Returns the UTF-8 byte length of a string.
 * Used to compute payload sizes for manifests.
 * @param {string} text
 * @returns {number}
 */
export function utf8ByteLength(text) {
    return new TextEncoder().encode(String(text || "")).length;
}

/**
 * Builds a week key string.
 * The key format matches the manifest chunk identifier (YYYY-Www).
 * @param {number} year
 * @param {number} week
 * @returns {string}
 */
export function chunkKey(year, week) {
    return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * Parses an ISO date (YYYY-MM-DD) into parts.
 * Throws an error when the input does not match the expected format.
 * @param {string} dateStr
 * @returns {{year: number, month: number, day: number}}
 */
export function parseIsoDate(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!match) {
        throw new Error(`Invalid ISO date: ${dateStr}`);
    }
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Formats a date from parts as ISO YYYY-MM-DD.
 * Pads components so string sorting remains chronological.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string}
 */
export function formatIsoDate(year, month, day) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Adds days to an ISO date string.
 * Uses UTC math to avoid local timezone shifts.
 * @param {string} dateStr
 * @param {number} deltaDays
 * @returns {string}
 */
export function addIsoDays(dateStr, deltaDays) {
    const { year, month, day } = parseIsoDate(dateStr);
    const dt = new Date(Date.UTC(year, month - 1, day));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return formatIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Returns ISO weekday index (Mon=0..Sun=6).
 * This index matches the week column layout in the UI.
 * @param {string} dateStr
 * @returns {number}
 */
export function isoWeekdayIndex(dateStr) {
    const { year, month, day } = parseIsoDate(dateStr);
    const dt = new Date(Date.UTC(year, month - 1, day));
    return (dt.getUTCDay() + 6) % 7;
}

/**
 * Returns the ISO week start (Monday) for a date.
 * The returned string is a YYYY-MM-DD date in the configured timezone.
 * @param {string} dateStr
 * @returns {string}
 */
export function isoWeekStart(dateStr) {
    return addIsoDays(dateStr, -isoWeekdayIndex(dateStr));
}

/**
 * Returns ISO year/week for a week start string.
 * Uses the ISO week algorithm based on the Thursday of the week.
 * @param {string} weekStartStr
 * @returns {{isoYear: number, week: number}}
 */
export function isoWeekInfo(weekStartStr) {
    const { year, month, day } = parseIsoDate(weekStartStr);
    const monday = new Date(Date.UTC(year, month - 1, day));
    const thursday = new Date(monday);
    thursday.setUTCDate(monday.getUTCDate() + 3);
    const isoYear = thursday.getUTCFullYear();

    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - jan4Weekday);

    const diffDays = Math.round((thursday.getTime() - week1Monday.getTime()) / (24 * 3600 * 1000));
    const week = 1 + Math.floor(diffDays / 7);
    return { isoYear, week };
}

/**
 * Returns the Monday date string for an ISO year/week.
 * This is used to map manifest chunks back to week start dates.
 * @param {number} isoYear
 * @param {number} week
 * @returns {string}
 */
export function isoWeekStartFromYearWeek(isoYear, week) {
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - jan4Weekday);
    const target = new Date(week1Monday);
    target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
    return formatIsoDate(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate());
}

/**
 * Parses HH:MM into minutes since midnight.
 * Returns null when parsing fails or values are out of range.
 * @param {string} text
 * @returns {number | null}
 */
export function hhmmToMinutes(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
    if (!match) {
        return null;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return null;
    }
    return hours * 60 + minutes;
}

/**
 * Formats minutes since midnight to HH:MM.
 * Clamps to the 00:00-24:00 range for display purposes.
 * @param {number} minutes
 * @returns {string}
 */
export function minutesToHHMM(minutes) {
    if (!Number.isFinite(minutes)) {
        return "—";
    }
    const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
    if (clamped === 1440) {
        return "24:00";
    }
    const hours = Math.floor(clamped / 60);
    const mins = clamped % 60;
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/**
 * Detects the data source mode from URL query parameters.
 * Defaults to GitHub mode unless "?source=local" is present.
 * @returns {"local" | "github"}
 */
export function getSourceMode() {
    try {
        const params = new URLSearchParams(window.location.search);
        const raw = String(params.get("source") || "").trim().toLowerCase();
        if (raw === "local") {
            return "local";
        }
    } catch {
        // ignore
    }
    return "github";
}

/**
 * Provides timezone-aware formatting utilities.
 * Encapsulates date math so views can operate in a single locale.
 */
export class TimeContext {
    /**
     * Builds formatter instances for the provided timezone.
     * Shared helper used across modules.
     * @param {string} timeZone
     */
    constructor(timeZone) {
        this.timeZone = timeZone;
        this.dateFmt = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
        this.timeFmt = new Intl.DateTimeFormat("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit" });
        this.tzPartsFmt = new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
    }

    /**
     * Formats a Date as a local YYYY-MM-DD string in the configured timezone.
     * Shared helper used across modules.
     * @param {Date} date
     * @returns {string}
     */
    formatDate(date) {
        return this.dateFmt.format(date);
    }

    /**
     * Formats a Date as a local HH:MM string in the configured timezone.
     * Shared helper used across modules.
     * @param {Date} date
     * @returns {string}
     */
    formatTime(date) {
        return this.timeFmt.format(date);
    }

    /**
     * Returns date-time parts for the configured timezone.
     * Shared helper used across modules.
     * @param {Date} date
     * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number}}
     */
    zonedParts(date) {
        const parts = this.tzPartsFmt.formatToParts(date);
        const out = {};
        for (const part of parts) {
            if (part.type === "year") out.year = Number(part.value);
            if (part.type === "month") out.month = Number(part.value);
            if (part.type === "day") out.day = Number(part.value);
            if (part.type === "hour") out.hour = Number(part.value);
            if (part.type === "minute") out.minute = Number(part.value);
            if (part.type === "second") out.second = Number(part.value);
        }
        return {
            year: out.year || 0,
            month: out.month || 0,
            day: out.day || 0,
            hour: out.hour || 0,
            minute: out.minute || 0,
            second: out.second || 0,
        };
    }

    /**
     * Computes the timezone offset in minutes at a given instant.
     * Shared helper used across modules.
     * @param {Date} date
     * @returns {number}
     */
    tzOffsetMinutesAt(date) {
        const parts = this.zonedParts(date);
        const asUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        return Math.round((asUtcMs - date.getTime()) / 60000);
    }

    /**
     * Converts local timezone parts into a Date, handling DST changes.
     * Shared helper used across modules.
     * @param {{year: number, month: number, day: number, hour: number, minute: number, second?: number}} parts
     * @returns {Date}
     */
    dateFromZonedParts(parts) {
        const localUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
        let guess = new Date(localUtcMs);
        let offsetMin = this.tzOffsetMinutesAt(guess);
        let dt = new Date(localUtcMs - offsetMin * 60000);
        for (let i = 0; i < 2; i++) {
            const nextOffsetMin = this.tzOffsetMinutesAt(dt);
            if (nextOffsetMin === offsetMin) {
                break;
            }
            offsetMin = nextOffsetMin;
            dt = new Date(localUtcMs - offsetMin * 60000);
        }
        return dt;
    }

    /**
     * Creates a Date from an ISO day string and minutes since midnight.
     * Shared helper used across modules.
     * @param {string} dayStr
     * @param {number} minutes
     * @returns {Date}
     */
    dateFromLocalDayMinutes(dayStr, minutes) {
        const { year, month, day } = parseIsoDate(dayStr);
        const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
        const hour = Math.floor(clamped / 60);
        const minute = clamped % 60;
        return this.dateFromZonedParts({ year, month, day, hour, minute, second: 0 });
    }

    /**
     * Formats a Date to an ISO string with explicit timezone offset.
     * Shared helper used across modules.
     * @param {Date} date
     * @returns {string}
     */
    formatIsoWithOffset(date) {
        const parts = this.zonedParts(date);
        const offsetMin = this.tzOffsetMinutesAt(date);
        const sign = offsetMin >= 0 ? "+" : "-";
        const abs = Math.abs(offsetMin);
        const offH = Math.floor(abs / 60);
        const offM = abs % 60;
        return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(
            parts.hour,
        ).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}${sign}${String(
            offH,
        ).padStart(2, "0")}:${String(offM).padStart(2, "0")}`;
    }

    /**
     * Returns week bounds in milliseconds for a Monday date string.
     * Shared helper used across modules.
     * @param {string} weekStart
     * @returns {{startMs: number, endMs: number} | null}
     */
    weekBoundsMs(weekStart) {
        if (!weekStart) {
            return null;
        }
        const startMs = this.dateFromLocalDayMinutes(weekStart, 0).getTime();
        const endMs = this.dateFromLocalDayMinutes(addIsoDays(weekStart, 7), 0).getTime();
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
            return null;
        }
        return { startMs, endMs };
    }
}

/**
 * Left-rotates a 32-bit number.
 * Used as a helper for the SHA-1 implementation.
 * @param {number} value
 * @param {number} bits
 * @returns {number}
 */
function rotl(value, bits) {
    return (value << bits) | (value >>> (32 - bits));
}

/**
 * Computes a SHA-1 digest of bytes as hex.
 * This implementation is used to verify Git blob SHA-1 values.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function sha1Hex(bytes) {
    const words = [];
    for (let i = 0; i < bytes.length; i++) {
        words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    }

    const bitLen = bytes.length * 8;
    words[bitLen >> 5] |= 0x80 << (24 - bitLen % 32);
    const totalWords = (((bitLen + 64) >> 9) << 4) + 16;
    words.length = Math.max(words.length, totalWords);
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    words[totalWords - 2] = hi;
    words[totalWords - 1] = lo;

    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;

    for (let i = 0; i < words.length; i += 16) {
        const w = new Array(80);
        for (let t = 0; t < 16; t++) {
            w[t] = words[i + t] | 0;
        }
        for (let t = 16; t < 80; t++) {
            w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
        }

        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;

        for (let t = 0; t < 80; t++) {
            let f;
            let k;
            if (t < 20) {
                f = (b & c) | (~b & d);
                k = 0x5a827999;
            } else if (t < 40) {
                f = b ^ c ^ d;
                k = 0x6ed9eba1;
            } else if (t < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdc;
            } else {
                f = b ^ c ^ d;
                k = 0xca62c1d6;
            }

            const temp = (rotl(a, 5) + f + e + k + w[t]) | 0;
            e = d;
            d = c;
            c = rotl(b, 30);
            b = a;
            a = temp;
        }

        h0 = (h0 + a) | 0;
        h1 = (h1 + b) | 0;
        h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0;
    }

    return `${toHex32(h0)}${toHex32(h1)}${toHex32(h2)}${toHex32(h3)}${toHex32(h4)}`;
}

/**
 * Formats a 32-bit number as zero-padded hex.
 * Ensures the SHA-1 output remains a fixed 8-char chunk.
 * @param {number} num
 * @returns {string}
 */
function toHex32(num) {
    return (num >>> 0).toString(16).padStart(8, "0");
}

/**
 * Computes a git-compatible blob SHA-1 for text content.
 * Prepends the "blob <len>\\0" header before hashing.
 * @param {string} content
 * @returns {string}
 */
export function gitBlobSha1(content) {
    const body = new TextEncoder().encode(String(content || ""));
    const header = new TextEncoder().encode(`blob ${body.length}\0`);
    const combined = new Uint8Array(header.length + body.length);
    combined.set(header);
    combined.set(body, header.length);
    return sha1Hex(combined);
}
