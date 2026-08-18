import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    DE_MESSAGES,
    EN_MESSAGES,
    LocaleService,
    resolveLocale,
} from "../locale.js";
import { Recurrence } from "../model.js";

test("English and German dictionaries expose the same complete key set", () => {
    assert.deepEqual(Object.keys(DE_MESSAGES).sort(), Object.keys(EN_MESSAGES).sort());
    assert.equal(DE_MESSAGES["landing.time"], "Zeiterfassung");
    assert.equal(DE_MESSAGES["landing.tasks"], "Aufgaben");
    assert.equal(DE_MESSAGES["landing.expenses"], "Ausgaben");
    assert.equal(DE_MESSAGES["landing.toGit"], "> Git");
    assert.match(EN_MESSAGES["landing.similarIntro"], /our review/);
    assert.doesNotMatch(EN_MESSAGES["landing.similarIntro"], /this review/);
});

test("all declarative document localization bindings resolve in the fallback dictionary", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    const keys = Array.from(
        html.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder|alt|content))?="([^"]+)"/g),
        (match) => match[1],
    );

    assert.ok(keys.length > 100, "expected the application document to expose comprehensive localization bindings");
    for (const key of keys) {
        assert.ok(Object.prototype.hasOwnProperty.call(EN_MESSAGES, key), `missing English message: ${key}`);
        assert.ok(Object.prototype.hasOwnProperty.call(DE_MESSAGES, key), `missing German message: ${key}`);
    }
});

test("all statically referenced view messages and plural families exist", async () => {
    const modules = ["app.js", "search.view.js", "todo.view.js", "week.view.js"];
    for (const moduleName of modules) {
        const source = await readFile(new URL(`../${moduleName}`, import.meta.url), "utf8");
        for (const match of source.matchAll(/\.t\(\s*"([^"]+)"/g)) {
            const key = match[1];
            assert.ok(Object.prototype.hasOwnProperty.call(EN_MESSAGES, key), `${moduleName}: missing message ${key}`);
        }
        for (const match of source.matchAll(/\.plural\(\s*"([^"]+)"/g)) {
            const baseKey = match[1];
            assert.ok(
                Object.prototype.hasOwnProperty.call(EN_MESSAGES, `${baseKey}.other`),
                `${moduleName}: missing plural family ${baseKey}`,
            );
        }
    }
});

test("explicit locale wins and automatic mode follows the browser language", () => {
    assert.equal(resolveLocale("de-DE", ["en-US"]), "de");
    assert.equal(resolveLocale("en", ["de-DE"]), "en");
    assert.equal(resolveLocale("auto", ["de-DE", "en-US"]), "de");
    assert.equal(resolveLocale("fr", ["de-DE"]), "en");
    assert.equal(resolveLocale("", ["fr-FR", "de-DE"]), "de");
    assert.equal(resolveLocale(null, ["fr-FR"]), "en");
});

test("localized presentation uses Intl without changing workspace timezone semantics", () => {
    const english = new LocaleService("en");
    const german = new LocaleService("de");
    const instant = "2026-01-01T00:30:00Z";

    assert.notEqual(english.formatNumber(1234.5), german.formatNumber(1234.5));
    assert.match(german.formatCurrency(12.5, "EUR"), /€/);
    assert.equal(german.formatDuration(-3660), "−1:01");
    assert.equal(english.formatDate(instant, "Europe/Berlin", { year: "numeric" }), "2026");
    assert.equal(english.formatDate(instant, "America/New_York", { year: "numeric" }), "2025");
    assert.equal(german.t("loading.progress", { loaded: 2, total: 4 }), "2/4 werden geladen…");
    assert.equal(german.localizeError(new Error("Entry shorter than 15 minutes.")), "Ein Eintrag muss mindestens 15 Minuten lang sein.");
});

test("structured recurrence descriptions follow the active interface language", () => {
    const friday = new Recurrence({
        frequency: "weekly",
        interval: 1,
        basis: "scheduled",
        weekdays: [5],
        source_text: "",
    });
    const completionRelative = new Recurrence({
        frequency: "monthly",
        interval: 2,
        basis: "after_completion",
        source_text: "every! 2 months",
    });
    const custom = new Recurrence({
        frequency: "custom",
        interval: 1,
        basis: "scheduled",
        source_text: "on every blue moon",
    });

    assert.equal(new LocaleService("en").describeRecurrence(friday, "Europe/Berlin"), "every Friday");
    assert.equal(new LocaleService("de").describeRecurrence(friday, "Europe/Berlin"), "jeden Freitag");
    assert.equal(
        new LocaleService("de").describeRecurrence(completionRelative, "Europe/Berlin"),
        "alle 2 Monate nach Abschluss",
    );
    assert.equal(new LocaleService("de").describeRecurrence(custom, "Europe/Berlin"), "on every blue moon");
});
