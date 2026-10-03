import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(HERE, "..", "deploy", "install.sh");
const ME = userInfo().username;
const root = mkdtempSync(join(tmpdir(), "deploy-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const OS = {
  silverblue: 'NAME="Fedora Linux"\nID=fedora\nVARIANT_ID=silverblue\nPRETTY_NAME="Fedora Linux 44 (Silverblue)"\n',
  bazzite: 'NAME="Bazzite"\nID=bazzite\nID_LIKE="fedora"\nVARIANT_ID=kinoite\nPRETTY_NAME="Bazzite"\n',
  fedora: 'NAME="Fedora Linux"\nID=fedora\nPRETTY_NAME="Fedora Linux 44 (Workstation Edition)"\n',
  rhel: 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9"\n',
  debian: 'ID=debian\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
  ubuntu: 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04 LTS"\n',
  arch: 'ID=arch\nPRETTY_NAME="Arch Linux"\n',
  manjaro: 'ID=manjaro\nID_LIKE=arch\nPRETTY_NAME="Manjaro Linux"\n',
  alpine: 'ID=alpine\nPRETTY_NAME="Alpine Linux v3.21"\n',
  void: 'ID=void\nPRETTY_NAME="Void Linux"\n',
  microos: 'ID="opensuse-microos"\nID_LIKE="suse opensuse opensuse-tumbleweed"\nPRETTY_NAME="openSUSE MicroOS"\n',
  tumbleweed: 'ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\nPRETTY_NAME="openSUSE Tumbleweed"\n',
  nixos: 'ID=nixos\nPRETTY_NAME="NixOS 25.05"\n',
  mystery: 'ID=exoticos\nPRETTY_NAME="ExoticOS"\n',
};

function fixture(name) {
  const path = join(root, `os-release-${name}`);
  writeFileSync(path, OS[name]);
  return path;
}

/** A fake `node` that reports a version, so the prerequisite check is not at the mercy of this machine. */
function fakeNode(major) {
  const dir = mkdtempSync(join(root, "node-"));
  const bin = join(dir, "node");
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in -p) echo ${major};; --version) echo v${major}.0.0;; *) echo ok;; esac\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function run(args, { os = "debian", env = {}, home } = {}) {
  const h = home ?? mkdtempSync(join(root, "home-"));
  const out = spawnSync("bash", [INSTALL, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: h, ROUTER_DEPLOY_OS_RELEASE: fixture(os), ROUTER_DEPLOY_NODE: fakeNode(24), ...env },
  });
  return { ...out, home: h, all: `${out.stdout}${out.stderr}` };
}

function stage(args, opts = {}) {
  const dir = mkdtempSync(join(root, "stage-"));
  const result = run([...args, "--stage", dir], opts);
  return { ...result, dir, at: (p) => join(dir, p), read: (p) => readFileSync(join(dir, p), "utf8") };
}

test("every distro profile is recognised: package manager, init, and immutability", () => {
  const expected = {
    silverblue: ["dnf", "systemd", "yes"],
    bazzite: ["dnf", "systemd", "yes"], // VARIANT_ID=kinoite: an ostree desktop
    fedora: ["dnf", "systemd", "no"],
    rhel: ["dnf", "systemd", "no"],
    debian: ["apt", "systemd", "no"],
    ubuntu: ["apt", "systemd", "no"],
    arch: ["pacman", "systemd", "no"],
    manjaro: ["pacman", "systemd", "no"],
    alpine: ["apk", "openrc", "no"],
    void: ["xbps", "runit", "no"],
    microos: ["zypper", "systemd", "yes"],
    tumbleweed: ["zypper", "systemd", "no"],
    nixos: ["nix", "systemd", "yes"],
  };
  for (const [os, [pkg, init, immutable]] of Object.entries(expected)) {
    const r = run(["print-os"], { os });
    assert.equal(r.status, 0, `${os}: ${r.all}`);
    assert.match(r.stdout, new RegExp(`packages:  ${pkg}\\n`), os);
    assert.match(r.stdout, new RegExp(`init:      ${init}\\n`), os);
    assert.match(r.stdout, new RegExp(`immutable: ${immutable}\\n`), os);
  }
  const unknown = run(["print-os"], { os: "mystery" });
  assert.match(unknown.stdout, /distro:    ExoticOS \(exoticos\)/);
  const mac = run(["print-os"], { env: { ROUTER_DEPLOY_UNAME: "Darwin" } });
  assert.match(mac.stdout, /os:        macos\n.*\n.*\n.*\ninit:      launchd/s);
});

test("a per-user systemd install lands in the user's config and data dirs, with the env file private", () => {
  const s = stage(["install"]);
  assert.equal(s.status, 0, s.all);
  const h = s.home;
  const unit = s.read(`${h}/.config/systemd/user/router-endpoint.service`);
  assert.match(unit, /^EnvironmentFile=.*\/\.config\/router-endpoint\/env$/m);
  assert.match(unit, /^ExecStart=\S+\/node \S+\/\.local\/share\/router-endpoint\/app\/src\/main\.mjs$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /^User=/m, "a user unit runs as the user already");
  assert.doesNotMatch(unit, /ProtectSystem|PrivateTmp/, "sandbox directives need user namespaces, which some distros disable for users");
  assert.doesNotMatch(unit, /network\.target/, "a user manager has no system targets to order on");
  assert.match(unit, /^Wants=laya\.service$/m);
  const laya = s.read(`${h}/.config/systemd/user/laya.service`);
  assert.match(laya, /Environment=LAYA_HOST=127\.0\.0\.1/, "Laya listens on loopback only");
  assert.match(laya, /ExecStart=\S+\/laya-venv\/bin\/python -m laya\.serve/);
  const envPath = s.at(`${h}/.config/router-endpoint/env`);
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  const env = readFileSync(envPath, "utf8");
  assert.match(env, /^ROUTER_HOST=127\.0\.0\.1$/m);
  assert.match(env, /^LAYA_URL=http:\/\/127\.0\.0\.1:8787$/m);
  assert.ok(existsSync(s.at(`${h}/.local/share/router-endpoint/app/src/main.mjs`)), "the app is copied, not run from the checkout");
  assert.ok(!existsSync(s.at(`${h}/.local/share/router-endpoint/app/test`)), "tests are not shipped");
});

test("a system systemd install runs as the named account, starts at boot, and is modestly sandboxed", () => {
  const s = stage(["install", "--system", "--run-as", ME]);
  assert.equal(s.status, 0, s.all);
  const unit = s.read("/etc/systemd/system/router-endpoint.service");
  assert.match(unit, new RegExp(`^User=${ME}$`, "m"));
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
  assert.match(unit, /^After=network-online\.target laya\.service$/m);
  for (const d of ["NoNewPrivileges=yes", "PrivateTmp=yes", "ProtectSystem=full", "RestrictSUIDSGID=yes"]) assert.match(unit, new RegExp(`^${d}$`, "m"));
  assert.doesNotMatch(unit, /ProtectHome|ProtectSystem=strict/, "the Claude CLI and pi must write under the account's home");
  assert.match(s.read("/etc/router-endpoint/env"), new RegExp(`^ROUTER_STATE=.*/\\.pi/agent/router-endpoint\\.json$`, "m"));
  assert.ok(existsSync(s.at("/var/lib/router-endpoint/app/src/main.mjs")));
  assert.match(s.all, /SELinux|installing for/);
});

test("--system without root, outside a stage or dry run, refuses and says what to do", { skip: process.getuid?.() === 0 }, () => {
  const r = run(["install", "--system", "--run-as", ME]);
  assert.notEqual(r.status, 0);
  assert.match(r.all, /re-run with sudo/);
  const missing = run(["install", "--system"]);
  assert.match(missing.all, /--system needs --run-as/);
});

test("Alpine gets an OpenRC service, Void a runit one, both as the named account", () => {
  const alpine = stage(["install", "--system", "--run-as", ME], { os: "alpine" });
  assert.equal(alpine.status, 0, alpine.all);
  const rc = alpine.read("/etc/init.d/router-endpoint");
  assert.match(rc, /^#!\/sbin\/openrc-run$/m);
  assert.match(rc, new RegExp(`^command_user="${ME}"$`, "m"));
  assert.match(rc, /^supervisor="supervise-daemon"$/m);
  assert.match(rc, /use laya/);
  assert.equal(statSync(alpine.at("/etc/init.d/router-endpoint")).mode & 0o111, 0o111, "init scripts are executable");
  assert.match(alpine.read("/var/lib/router-endpoint/run"), /^\. "\/etc\/router-endpoint\/env"$/m, "the wrapper loads the env file itself");
  assert.ok(existsSync(alpine.at("/etc/init.d/laya")));

  const voidr = stage(["install", "--system", "--run-as", ME], { os: "void" });
  assert.equal(voidr.status, 0, voidr.all);
  assert.match(voidr.read("/etc/sv/router-endpoint/run"), new RegExp(`exec chpst -u ${ME} /var/lib/router-endpoint/run`));
  assert.ok(existsSync(voidr.at("/etc/sv/laya/run")));

  // Refused up front: nothing is downloaded or written before the combination is rejected.
  const home = mkdtempSync(join(root, "home-"));
  const userOpenrc = run(["install", "--user"], { os: "alpine", home });
  assert.notEqual(userOpenrc.status, 0);
  assert.match(userOpenrc.all, /OpenRC services are system-wide/);
  assert.deepEqual(readdirSync(home), [], "nothing was written");
  assert.match(run(["install", "--user"], { os: "void" }).all, /runit services are system-wide/);
});

test("macOS gets launchd agents whose plists parse", () => {
  const s = stage(["install"], { env: { ROUTER_DEPLOY_UNAME: "Darwin", ROUTER_DEPLOY_OS_RELEASE: "" } });
  assert.equal(s.status, 0, s.all);
  const plist = s.at(`${s.home}/Library/LaunchAgents/dev.mmmgc.router-endpoint.plist`);
  const parsed = spawnSync("python3", ["-c", "import plistlib,sys,json; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", plist], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  const data = JSON.parse(parsed.stdout);
  assert.equal(data.Label, "dev.mmmgc.router-endpoint");
  assert.equal(data.KeepAlive, true);
  assert.match(data.ProgramArguments[0], /\.local\/share\/router-endpoint\/run$/);
  assert.match(data.StandardOutPath, /Library\/Logs\/router-endpoint\.log$/);
  assert.match(s.read(`${s.home}/.local/share/router-endpoint/run`), /^exec ".*node" ".*main\.mjs"$/m);
});

test("a missing or old Node stops the install with the hint for this distro", () => {
  const hint = (os, pattern) => {
    const r = run(["install", "--dry-run"], { os, env: { ROUTER_DEPLOY_NODE: fakeNode(18) } });
    assert.notEqual(r.status, 0, os);
    assert.match(r.all, /needs 20 or newer/, os);
    assert.match(r.all, pattern, os);
  };
  hint("debian", /nodesource|nvm/);
  hint("fedora", /sudo dnf install nodejs/);
  hint("silverblue", /immutable.*brew install node.*rpm-ostree install nodejs/s);
  hint("arch", /pacman -S nodejs/);
  hint("alpine", /apk add nodejs/);
  hint("void", /xbps-install nodejs/);
  hint("tumbleweed", /zypper install nodejs20/);
  hint("nixos", /nodejs_22/);
  hint("mystery", /nodejs\.org/);
});

test("re-running keeps a hand-edited env file; --force-env rewrites it; --no-laya drops the Laya unit and URL", () => {
  const home = mkdtempSync(join(root, "home-"));
  const dir = mkdtempSync(join(root, "stage-"));
  const envPath = join(dir, home, ".config", "router-endpoint", "env");
  assert.equal(run(["install", "--stage", dir], { home }).status, 0);
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}TYPESAFE_API_KEY=my-edit\n`);

  const again = run(["install", "--stage", dir], { home });
  assert.match(again.all, /env: keeping/);
  assert.match(readFileSync(envPath, "utf8"), /TYPESAFE_API_KEY=my-edit/);

  const noLaya = run(["install", "--stage", dir, "--no-laya"], { home });
  assert.equal(noLaya.status, 0, noLaya.all);
  const env = readFileSync(envPath, "utf8");
  assert.match(env, /^LAYA_URL=$/m, "no Laya, no dead URL to time out on");
  assert.match(env, /TYPESAFE_API_KEY=my-edit/, "the edit survives the URL fix");
  assert.ok(!existsSync(join(dir, home, ".config", "systemd", "user", "laya.service")));
  assert.doesNotMatch(readFileSync(join(dir, home, ".config", "systemd", "user", "router-endpoint.service"), "utf8"), /Wants=laya/);

  const back = run(["install", "--stage", dir], { home });
  assert.match(readFileSync(envPath, "utf8"), /^LAYA_URL=http:\/\/127\.0\.0\.1:8787$/m, "turning Laya back on restores the URL");

  assert.equal(run(["install", "--stage", dir, "--force-env", "--port", "9001"], { home }).status, 0);
  const forced = readFileSync(envPath, "utf8");
  assert.match(forced, /^ROUTER_PORT=9001$/m);
  assert.doesNotMatch(forced, /my-edit/);
  assert.equal(back.status, 0);
});

test("--dry-run prints the files and changes nothing", () => {
  const home = mkdtempSync(join(root, "home-"));
  const r = run(["install", "--dry-run"], { home });
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /--- .*router-endpoint\.service \(mode 644\)/);
  assert.match(r.stdout, /--- .*\/env \(mode 600\)/);
  assert.match(r.stdout, /dry run: nothing was changed/);
  assert.deepEqual(readdirSync(home), [], "nothing was written");
});

test("a path with a space or shell character is refused rather than written into a unit", () => {
  const r = run(["install", "--dry-run"], { home: join(mkdtempSync(join(root, "h-")), "has space") });
  assert.notEqual(r.status, 0);
  assert.match(r.all, /space or shell character/);
});

test("uninstall removes the service files and keeps config unless --purge", () => {
  const home = mkdtempSync(join(root, "home-"));
  const dir = mkdtempSync(join(root, "stage-"));
  assert.equal(run(["install", "--stage", dir], { home }).status, 0);
  const unit = join(dir, home, ".config", "systemd", "user", "router-endpoint.service");
  const env = join(dir, home, ".config", "router-endpoint", "env");
  assert.ok(existsSync(unit));
  const kept = run(["uninstall", "--stage", dir], { home });
  assert.equal(kept.status, 0, kept.all);
  assert.ok(!existsSync(unit));
  assert.ok(existsSync(env), "config stays");
  assert.match(kept.all, /--purge removes/);
  const purged = run(["uninstall", "--stage", dir, "--purge"], { home });
  assert.equal(purged.status, 0, purged.all);
  assert.ok(!existsSync(env));
  assert.ok(!existsSync(join(dir, home, ".local", "share", "router-endpoint", "app")));
  assert.match(purged.all, /state file.*is kept/);
});

test("bad options are rejected with a message", () => {
  assert.match(run(["install", "--port", "99999"]).all, /--port must be 1-65535/);
  assert.match(run(["install", "--port", "eighty"]).all, /--port must be a number/);
  assert.match(run(["install", "--bogus"]).all, /unknown option: --bogus/);
  for (const bad of ["x; touch /tmp/pwned", "$(id)", "Has Space", "../etc", "`id`", "A"]) {
    const r = run(["install", "--system", "--run-as", bad, "--dry-run"]);
    assert.notEqual(r.status, 0, bad);
    assert.match(r.all, /--run-as must be a login name/, bad);
  }
  assert.ok(!existsSync("/tmp/pwned"), "a hostile --run-as never reached a shell");
  for (const good of ["svc-user_1", "j", "_apt", "deploy.bot"]) {
    assert.doesNotMatch(run(["install", "--system", "--run-as", good, "--dry-run"]).all, /must be a login name/, `${good} is a valid login name`);
  }
  assert.match(run(["--help"]).stdout, /Commands/);
});
