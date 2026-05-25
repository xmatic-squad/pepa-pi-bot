// Optional prismarine-viewer launch — local visual debugging surface.
// Activated by setting VIEWER_PORT in .env (e.g. 3007). The dependency is
// not required at runtime: if `prismarine-viewer` is not installed, this
// module logs once and returns, so production deploys aren't forced to
// carry the extra dep.

import { info, warn } from "./log.js";
import { config } from "./config.js";

let started = false;

export async function maybeStartViewer(bot) {
	if (started) return;
	const port = config.viewerPort;
	if (!port) return;
	let mineflayerViewer;
	try {
		({ mineflayer: mineflayerViewer } = await import("prismarine-viewer"));
	} catch (e) {
		warn("viewer", `VIEWER_PORT=${port} requested but prismarine-viewer is not installed (npm i prismarine-viewer)`);
		return;
	}
	try {
		mineflayerViewer(bot, { port, firstPerson: false });
		started = true;
		info("viewer", `prismarine-viewer listening on http://localhost:${port}`);
	} catch (e) {
		warn("viewer", `failed to start: ${e?.message ?? e}`);
	}
}
