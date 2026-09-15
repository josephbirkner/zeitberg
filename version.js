import { BUILD_INFO } from "./build-info.js";

/**
 * Formats immutable artifact metadata without claiming an unknown revision.
 * @param {{version: string, commit: string, dirty: boolean}} info Build metadata.
 * @returns {string} Compact diagnostic label.
 */
export function formatBuildLabel(info) {
    const commit = /^[a-f0-9]{40}$/i.test(info.commit) ? info.commit.slice(0, 8) : "unbuilt";
    return `v${info.version} · ${commit}${info.dirty ? " + local changes" : ""}`;
}

/**
 * Displays the loaded build, linking only validated commit identifiers to source.
 * No request to GitHub is needed, so older cached deployments keep truthful labels.
 * @param {HTMLAnchorElement} element Landing-page build label.
 * @returns {void}
 */
export function showBuildInfo(element) {
    element.textContent = formatBuildLabel(BUILD_INFO);
    element.title = BUILD_INFO.commit || "Unbuilt static checkout";
    if (/^[a-f0-9]{40}$/i.test(BUILD_INFO.commit)) {
        element.href = `https://github.com/josephbirkner/zeitberg/commit/${BUILD_INFO.commit}`;
    } else element.removeAttribute("href");
}
