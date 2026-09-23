/**
 * Which build of the router is running, and whether the channel it tracks has moved on.
 *
 * pi owns install and update (`pi install git:…`, `pi update`); nothing here replaces that. This
 * file adds only the facts a user cannot otherwise see: the channel, version and commit of the
 * code in *this* process, the settings entry pi would fetch from next, and — only when explicitly
 * asked — the tip of that ref. It is read-only in both directions: pi's settings and its clone are
 * read, never written, and the one network call lives behind `checkRemote`, which nothing but the
 * `/router update` command calls.
 *
 * Channel comes from the version in package.json, not from the checkout's branch name: pi resets
 * its clone to a fetched commit (`git reset --hard FETCH_HEAD`), so the local branch label there
 * can name a branch the working tree no longer holds. `X.Y.Z-dev` travels with the code and cannot
 * lie about it; the tracked ref is reported beside it as what pi will pull, not as what is running.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Channel = "dev" | "stable" | "unknown";

export type SettingsScope = "user" | "project";

export interface SettingsFile {
	path: string;
	scope: SettingsScope;
	/** Base directory a relative `local:` source in this file resolves against. */
	baseDir: string;
}

/** A `packages` entry in pi's settings that resolves to the directory this extension runs from. */
export interface TrackedSource {
	/** The entry exactly as settings spells it, which is also what `pi update <source>` takes. */
	source: string;
	scope: SettingsScope;
	kind: "git" | "local";
	/** `github.com` for a git entry. */
	host?: string;
	/** `<owner>/<repo>` for a git entry. */
	path?: string;
	/** The ref after `@`. Absent means pi follows the remote's default branch. */
	ref?: string;
}

export interface ReleaseInfo {
	/** package.json version of the running code, or `unknown` if it could not be read. */
	version: string;
	channel: Channel;
	/** HEAD of the checkout this code runs from, when it is a git checkout at all. */
	commit?: string;
	installPath: string;
	/** The settings entry pi would update, when the install path is a pi-managed package. */
	tracked?: TrackedSource;
	/** `origin` of the checkout, used when no settings entry claims it. */
	originUrl?: string;
}

export type RemoteCheck =
	| { ok: true; ref: string; commit: string; upToDate: boolean }
	| { ok: false; error: string };

const SHA = /^[0-9a-f]{40}$/;

// ---- local facts -----------------------------------------------------------

/**
 * Everything knowable without the network. Every read is best-effort: a missing package.json,
 * a non-git install or an unreadable settings file degrades a field, never throws.
 */
export function readReleaseInfo(opts?: { moduleDir?: string; agentDir?: string; settingsFiles?: SettingsFile[] }): ReleaseInfo {
	const installPath = findInstallRoot(opts?.moduleDir ?? defaultModuleDir());
	const version = readVersion(installPath);
	const gitDir = findGitDir(installPath);
	const info: ReleaseInfo = {
		version,
		channel: channelOf(version),
		commit: gitDir ? readHead(gitDir) : undefined,
		installPath,
		originUrl: gitDir ? readOriginUrl(gitDir) : undefined,
	};
	info.tracked = findTrackedSource(installPath, opts?.agentDir, opts?.settingsFiles ?? []);
	return info;
}

/**
 * `X.Y.Z` is a promoted release on the stable channel; `X.Y.Z-dev` is what dev carries between
 * them. Any other prerelease is something this scheme does not name, and says so rather than
 * guessing a channel for it.
 */
export function channelOf(version: string): Channel {
	const m = version.match(/^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
	if (!m) return "unknown";
	if (!m[1]) return "stable";
	return /^dev(?:\.|$)/.test(m[1]) ? "dev" : "unknown";
}

function defaultModuleDir(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return process.cwd();
	}
}

/** The package root: the nearest ancestor of this module that carries a package.json. */
function findInstallRoot(from: string): string {
	let dir = from;
	for (let i = 0; i < 10; i++) {
		if (existsSync(join(dir, "package.json"))) return canonical(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return canonical(from);
}

function canonical(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return resolve(dir);
	}
}

function readVersion(installPath: string): string {
	try {
		const pkg = JSON.parse(readFileSync(join(installPath, "package.json"), "utf-8")) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

/** `.git` is a directory in a clone and a `gitdir:` pointer file in a worktree. */
function findGitDir(installPath: string): string | undefined {
	const dotGit = join(installPath, ".git");
	try {
		const st = statSync(dotGit);
		if (st.isDirectory()) return dotGit;
		const pointer = readFileSync(dotGit, "utf-8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
		if (!pointer) return undefined;
		return isAbsolute(pointer) ? pointer : resolve(installPath, pointer);
	} catch {
		return undefined;
	}
}

/**
 * HEAD without spawning git: a detached HEAD (which is what pi's own clone usually has) holds the
 * sha outright, a branch resolves through loose refs and then packed-refs. A linked worktree keeps
 * its refs in the common dir, so that is where a ref is looked up second.
 */
function readHead(gitDir: string): string | undefined {
	const head = readTrimmed(join(gitDir, "HEAD"));
	if (!head) return undefined;
	if (SHA.test(head)) return head;
	const ref = head.match(/^ref:\s*(.+)$/)?.[1]?.trim();
	if (!ref) return undefined;
	const dirs = [gitDir];
	const common = readTrimmed(join(gitDir, "commondir"));
	if (common) dirs.push(isAbsolute(common) ? common : resolve(gitDir, common));
	for (const dir of dirs) {
		const loose = readTrimmed(join(dir, ref));
		if (loose && SHA.test(loose)) return loose;
		const packed = readTrimmed(join(dir, "packed-refs"));
		const line = packed?.split("\n").find((l) => l.endsWith(` ${ref}`));
		const sha = line?.split(/\s+/)[0];
		if (sha && SHA.test(sha)) return sha;
	}
	return undefined;
}

function readTrimmed(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8").trim();
	} catch {
		return undefined;
	}
}

function readOriginUrl(gitDir: string): string | undefined {
	const config = readTrimmed(join(gitDir, "config"));
	if (!config) return undefined;
	const section = config.split(/^\[/m).find((s) => /^remote\s+"origin"\]/.test(s));
	return section?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
}

// ---- pi's settings ---------------------------------------------------------

/**
 * pi's shorthand, as `parseGitUrl` in pi reads it: an optional `git:` prefix, `host/owner/repo`,
 * and an optional `@ref` after the host. The ref is what makes the entry a channel; without one pi
 * follows the remote's default branch.
 */
export function parseGitSource(source: string): { host: string; path: string; ref?: string } | undefined {
	const trimmed = source.trim();
	if (trimmed.startsWith("npm:")) return undefined;
	const hasGitPrefix = trimmed.startsWith("git:") && !trimmed.startsWith("git://");
	let rest = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;
	const scp = rest.match(/^git@([^:]+):(.+)$/);
	if (scp) rest = `${scp[1]}/${scp[2]}`;
	else if (/^(?:https?|ssh|git):\/\//.test(rest)) rest = rest.replace(/^(?:https?|ssh|git):\/\//, "").replace(/^[^/@]+@/, "");
	else if (!hasGitPrefix) return undefined; // a bare path is a local package, not a repository
	const slash = rest.indexOf("/");
	if (slash < 0) return undefined;
	const host = rest.slice(0, slash);
	let path = rest.slice(slash + 1);
	let ref: string | undefined;
	const at = path.indexOf("@");
	if (at > 0) {
		ref = path.slice(at + 1) || undefined;
		path = path.slice(0, at);
	}
	path = path.replace(/\.git$/, "").replace(/\/+$/, "");
	if (!/^[^/@.]+(?:\.[^/@.]+)+$/.test(host) && host !== "localhost") return undefined;
	if (path.split("/").length < 2) return undefined;
	return { host, path, ref };
}

/** Where pi clones `<host>/<owner>/<repo>` for a user-scope package. */
function gitInstallPath(agentDir: string, host: string, path: string): string {
	return join(agentDir, "git", host, path);
}

/**
 * The settings entry that owns this install, found by where it would put the package rather than
 * by the repository's name — so a fork, a rename or a project-scope entry is still recognised, and
 * a checkout nothing installed (a dev clone loaded with `-e`) is reported as exactly that.
 */
function findTrackedSource(installPath: string, agentDir: string | undefined, files: SettingsFile[]): TrackedSource | undefined {
	for (const file of files) {
		for (const entry of readPackages(file.path)) {
			const git = parseGitSource(entry);
			if (git && agentDir) {
				if (canonical(gitInstallPath(agentDir, git.host, git.path)) === installPath) {
					return { source: entry, scope: file.scope, kind: "git", ...git };
				}
				continue;
			}
			if (git || entry.startsWith("npm:")) continue;
			const local = resolve(file.baseDir, entry);
			if (canonical(local) === installPath) return { source: entry, scope: file.scope, kind: "local" };
		}
	}
	return undefined;
}

function readPackages(path: string): string[] {
	try {
		const settings = JSON.parse(readFileSync(path, "utf-8")) as { packages?: unknown };
		if (!Array.isArray(settings.packages)) return [];
		return settings.packages
			.map((p) => (typeof p === "string" ? p : typeof (p as { source?: unknown })?.source === "string" ? (p as { source: string }).source : ""))
			.filter((p) => p.length > 0);
	} catch {
		return [];
	}
}

// ---- the remote, only when asked -------------------------------------------

/**
 * The tip of the ref pi would fetch next. `ls-remote` reads refs only: it downloads no objects and
 * changes nothing in the clone. Bounded, and every failure — offline, no remote, no such ref —
 * comes back as `ok: false` for the caller to report beside the local facts.
 */
export async function checkRemote(info: ReleaseInfo, opts?: { timeoutMs?: number }): Promise<RemoteCheck> {
	const cwd = info.installPath;
	// The clone's own `origin` is what pi fetches from, so asking it keeps ssh, forks and mirrors
	// working; the settings entry contributes only the ref, which is what makes it the channel.
	const remote = info.originUrl ?? "origin";
	const ref = info.tracked?.ref;
	const args = ref ? ["ls-remote", remote, ref] : ["ls-remote", "--symref", remote, "HEAD"];
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: opts?.timeoutMs ?? 6000, windowsHide: true });
		const resolvedRef = ref ?? stdout.match(/^ref:\s*refs\/heads\/(\S+)\s+HEAD$/m)?.[1] ?? "HEAD";
		const commit = stdout
			.split("\n")
			.map((l) => l.trim().split(/\s+/)[0] ?? "")
			.find((s) => SHA.test(s));
		if (!commit) return { ok: false, error: `remote has no ref ${resolvedRef}` };
		return { ok: true, ref: resolvedRef, commit, upToDate: info.commit === commit };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg.split("\n").slice(-2).join(" ").trim() || "git ls-remote failed" };
	}
}

// ---- reporting -------------------------------------------------------------

export function shortSha(sha: string | undefined): string {
	return sha ? sha.slice(0, 7) : "unknown commit";
}

/** One line for the status card: what is running, and what pi would pull over it. */
export function releaseLine(info: ReleaseInfo): string {
	const bits = [`${info.version} (${info.channel})`, shortSha(info.commit)];
	if (info.tracked) bits.push(`tracking ${info.tracked.source}${info.tracked.ref ? "" : " (default branch)"}`);
	else bits.push(`not pi-installed: ${info.installPath}`);
	return `release: ${bits.join("  ")}`;
}

/** The exact commands that move this install, built from the entry pi actually holds. */
export function moveCommands(info: ReleaseInfo): string[] {
	const t = info.tracked;
	if (!t) return [`this checkout is not a pi package; install one with: pi install git:github.com/<owner>/<repo>@dev`];
	if (t.kind === "local") return [`local package (${t.source}); pull it with git in ${info.installPath}`];
	const base = `git:${t.host}/${t.path}`;
	return [
		`update on this channel:  pi update ${t.source}`,
		`switch to dev:           pi install ${base}@dev`,
		`switch to stable:        pi install ${base}@main`,
	];
}

/** The `/router update` card: local facts first, so an offline check still answers something. */
export function updateLines(info: ReleaseInfo, remote?: RemoteCheck): string[] {
	const lines = [releaseLine(info)];
	if (remote?.ok === true) {
		// Ancestry is not knowable without fetching objects, so the two commits are reported as
		// differing rather than as one being behind the other; what pi would do with that is separate.
		const moves = info.tracked?.kind === "git" ? "; pi update moves this install to it" : "";
		lines.push(
			remote.upToDate
				? `remote ${remote.ref}: ${shortSha(remote.commit)} — up to date`
				: `remote ${remote.ref}: ${shortSha(remote.commit)} — differs from the installed ${shortSha(info.commit)}${moves}`,
		);
	} else if (remote) {
		lines.push(`remote check failed (${remote.error}); the facts above are local only`);
	}
	lines.push(...moveCommands(info));
	return lines;
}
