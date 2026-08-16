/**
 * Applies the stored light theme before stylesheets render, avoiding a dark-theme flash.
 * This tiny first-party script remains external so the deployment can enforce a script-src policy without unsafe inline JavaScript.
 * @returns {void}
 */
function applyStoredTheme() {
    try {
        const savedConfig = JSON.parse(localStorage.getItem("tt_viewer:config:v1") || "{}");
        if (savedConfig.theme === "light") document.documentElement.dataset.theme = "light";
    } catch {
        // Invalid or unavailable browser storage leaves the dark default intact.
    }
}

applyStoredTheme();
