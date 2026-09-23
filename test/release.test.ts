/**
 * Which build is running and which channel it tracks. The facts come from three places that can
 * each disagree — the version in package.json, the checkout's HEAD, and pi's settings entry — so
 * these tests fix what each is allowed to answer for: the version names the channel, the settings
 * entry names only what pi would fetch next, and neither is read off the checkout's branch label,
 * which pi's own `reset --hard` leaves pointing at whatever branch was cloned first.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkRemote, channelOf, moveCommands, parseGitSource, readReleaseInfo, releaseLine, type SettingsFile, updateLines } from "../src/release.ts";

/** A pi-shaped agent dir with a cloned package at `git/<host>/<owner>/<repo>`. */
function agentDir(opts: { version?: string; head?: string; packedRef?: string; packages?: unknown[]; branch?: string }): {
	dir: string;
	install: string;
	settingsFiles: SettingsFile[];
} {
	const dir = mkdtempSync(join(tmpdir(), "mr-agent-"));
	const install = join(dir, "git", "github.com", "JoelHarlander", "mmmgc_modelrouter");
	mkdirSync(join(install, ".git"), { recursive: true });
	writeFileSync(join(install, "package.json"), JSON.stringify({ name: "pi-modelrouter", version: opts.version ?? "0.1.0" }));
	writeFileSync(join(install, ".git", "HEAD"), opts.branch ? `ref: refs/heads/${opts.branch}\n` : `${opts.head ?? "a".repeat(40)}\n`);
	if (opts.packedRef) writeFileSync(join(install, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${opts.packedRef} refs/heads/${opts.branch}\n`);
	if (opts.packages) writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: opts.packages }));
	return {
		dir,
		install,
		settingsFiles: [{ path: join(dir, "settings.json"), scope: "user", baseDir: dir }],
	};
}

test("the version names the channel, so a dev build says dev wherever it is checked out", () => {
	assert.equal(channelOf("0.2.0"), "stable");
	assert.equal(channelOf("0.2.0-dev"), "dev");
	assert.equal(channelOf("1.0.0-dev.3"), "dev");
	// A scheme this project does not define must not be guessed into a channel.
	assert.equal(channelOf("0.2.0-rc.1"), "unknown");
	assert.equal(channelOf("unknown"), "unknown");
});

test("the settings entry is found by where pi would clone it, not by the repository's name", () => {
	const a = agentDir({ version: "0.3.0-dev", head: "b".repeat(40), packages: ["npm:pi-claude-bridge", "git:github.com/JoelHarlander/mmmgc_modelrouter@dev"] });
	const info = readReleaseInfo({ moduleDir: join(a.install, "src"), agentDir: a.dir, settingsFiles: a.settingsFiles });

	assert.equal(info.version, "0.3.0-dev");
	assert.equal(info.channel, "dev");
	assert.equal(info.commit, "b".repeat(40));
	assert.equal(info.installPath, realpathSync(a.install));
	assert.equal(info.tracked?.source, "git:github.com/JoelHarlander/mmmgc_modelrouter@dev");
	assert.equal(info.tracked?.ref, "dev");
	assert.equal(info.tracked?.scope, "user");
});

test("an unqualified entry is reported as following the default branch, not as a pinned ref", () => {
	const a = agentDir({ packages: ["git:github.com/JoelHarlander/mmmgc_modelrouter"] });
	const info = readReleaseInfo({ moduleDir: a.install, agentDir: a.dir, settingsFiles: a.settingsFiles });

	assert.equal(info.tracked?.ref, undefined);
	assert.match(releaseLine(info), /default branch/);
	// The move commands are built from the entry pi holds, so they name the same repository.
	const cmds = moveCommands(info).join("\n");
	assert.match(cmds, /pi update git:github\.com\/JoelHarlander\/mmmgc_modelrouter/);
	assert.match(cmds, /pi install git:github\.com\/JoelHarlander\/mmmgc_modelrouter@dev/);
	assert.match(cmds, /pi install git:github\.com\/JoelHarlander\/mmmgc_modelrouter@main/);
});

test("a settings entry for another package never claims this install", () => {
	const a = agentDir({ packages: ["git:github.com/someone/other-extension@dev", "npm:pi-claude-bridge"] });
	const info = readReleaseInfo({ moduleDir: a.install, agentDir: a.dir, settingsFiles: a.settingsFiles });

	assert.equal(info.tracked, undefined);
	assert.match(releaseLine(info), /not pi-installed/);
	assert.match(moveCommands(info).join("\n"), /not a pi package/);
});

test("a branch checkout resolves its commit through packed-refs, as a fresh clone has them", () => {
	const a = agentDir({ branch: "dev", packedRef: "c".repeat(40) });
	const info = readReleaseInfo({ moduleDir: a.install, agentDir: a.dir, settingsFiles: a.settingsFiles });
	assert.equal(info.commit, "c".repeat(40));
});

test("missing package.json or git dir degrades a field instead of throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "mr-bare-"));
	const info = readReleaseInfo({ moduleDir: dir, agentDir: dir, settingsFiles: [] });
	assert.equal(info.version, "unknown");
	assert.equal(info.channel, "unknown");
	assert.equal(info.commit, undefined);
});

test("pi's source shorthand is read the way pi reads it, and a local path is not a repository", () => {
	assert.deepEqual(parseGitSource("git:github.com/o/r@dev"), { host: "github.com", path: "o/r", ref: "dev" });
	assert.deepEqual(parseGitSource("git:github.com/o/r"), { host: "github.com", path: "o/r", ref: undefined });
	assert.deepEqual(parseGitSource("https://github.com/o/r.git"), { host: "github.com", path: "o/r", ref: undefined });
	assert.deepEqual(parseGitSource("git:git@github.com:o/r@v1.2.3"), { host: "github.com", path: "o/r", ref: "v1.2.3" });
	assert.equal(parseGitSource("npm:pi-claude-bridge"), undefined);
	assert.equal(parseGitSource("./local/path"), undefined);
	assert.equal(parseGitSource("../checkouts/modelrouter"), undefined);
});

test("a project-local checkout is named as one rather than offered pi update commands", () => {
	const dir = mkdtempSync(join(tmpdir(), "mr-proj-"));
	const install = join(dir, "checkout");
	mkdirSync(install, { recursive: true });
	writeFileSync(join(install, "package.json"), JSON.stringify({ version: "0.2.0-dev" }));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [{ source: "./checkout" }] }));

	const info = readReleaseInfo({
		moduleDir: install,
		agentDir: dir,
		settingsFiles: [{ path: join(dir, "settings.json"), scope: "project", baseDir: dir }],
	});
	assert.equal(info.tracked?.kind, "local");
	assert.match(moveCommands(info).join("\n"), /local package/);
});

test("an offline remote check still reports the local facts and says which part failed", () => {
	const a = agentDir({ version: "0.2.0", packages: ["git:github.com/JoelHarlander/mmmgc_modelrouter@main"] });
	const info = readReleaseInfo({ moduleDir: a.install, agentDir: a.dir, settingsFiles: a.settingsFiles });
	const lines = updateLines(info, { ok: false, error: "could not resolve host" }).join("\n");

	assert.match(lines, /release: 0\.2\.0 \(stable\)/);
	assert.match(lines, /remote check failed \(could not resolve host\); the facts above are local only/);
	assert.match(lines, /pi update git:github\.com/);
});

test("the remote check reads refs off a real remote and never moves the checkout", async () => {
	const root = mkdtempSync(join(tmpdir(), "mr-remote-"));
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
	const origin = join(root, "origin");
	mkdirSync(origin);
	git(origin, "init", "-q", "-b", "main", ".");
	git(origin, "config", "user.email", "t@example.invalid");
	git(origin, "config", "user.name", "t");
	writeFileSync(join(origin, "package.json"), JSON.stringify({ version: "0.1.0" }));
	git(origin, "add", ".");
	git(origin, "commit", "-qm", "release");
	git(origin, "branch", "dev");

	const clone = join(root, "clone");
	git(root, "clone", "-q", origin, clone);
	const released = git(origin, "rev-parse", "HEAD");

	// Tracking the default branch: the check resolves which branch that is, and agrees with HEAD.
	const atMain = readReleaseInfo({ moduleDir: clone, agentDir: root, settingsFiles: [] });
	assert.equal(atMain.commit, released);
	const mainCheck = await checkRemote(atMain);
	assert.deepEqual(mainCheck, { ok: true, ref: "main", commit: released, upToDate: true });

	// dev moves ahead; the installed commit has not, which is exactly what the command must say.
	git(origin, "checkout", "-q", "dev");
	git(origin, "commit", "-qm", "dev work", "--allow-empty");
	const devTip = git(origin, "rev-parse", "dev");
	assert.notEqual(devTip, released);

	const onDev: typeof atMain = { ...atMain, tracked: { source: "git:github.com/o/r@dev", scope: "user", kind: "git", host: "github.com", path: "o/r", ref: "dev" } };
	const devCheck = await checkRemote(onDev);
	assert.deepEqual(devCheck, { ok: true, ref: "dev", commit: devTip, upToDate: false });
	assert.match(updateLines(onDev, devCheck).join("\n"), /differs from the installed/);

	// A ref the channel does not have is a failed check, not a silent "up to date".
	const missing = await checkRemote({ ...onDev, tracked: { ...onDev.tracked!, ref: "no-such-branch" } });
	assert.equal(missing.ok, false);

	assert.equal(git(clone, "rev-parse", "HEAD"), released, "ls-remote must not move the clone");
});

test("a remote tip that differs from HEAD is reported as the commit pi update would move to", () => {
	const a = agentDir({ version: "0.3.0-dev", head: "d".repeat(40), packages: ["git:github.com/JoelHarlander/mmmgc_modelrouter@dev"] });
	const info = readReleaseInfo({ moduleDir: a.install, agentDir: a.dir, settingsFiles: a.settingsFiles });

	const behind = updateLines(info, { ok: true, ref: "dev", commit: "e".repeat(40), upToDate: false }).join("\n");
	assert.match(behind, /remote dev: eeeeeee — differs from the installed ddddddd; pi update moves this install to it/);
	const current = updateLines(info, { ok: true, ref: "dev", commit: "d".repeat(40), upToDate: true }).join("\n");
	assert.match(current, /remote dev: ddddddd — up to date/);
});
