// Zero-dependency test for the desktop app's world boundary.
// Proves the privileged chrome/IPC shim lives in the preload's isolated world,
// is not visible on window, and is still usable by injected content scripts.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_DIR = __dirname;
const preloadSource = fs.readFileSync(path.join(APP_DIR, "src", "preload.js"), "utf8");
const mainSource = fs.readFileSync(path.join(APP_DIR, "src", "main.js"), "utf8");

function runPreload(host, marker) {
  const invocations = [];
  const mainWorldScripts = [];
  const insertedCss = [];
  const windowStub = {};
  const documentStub = {
    readyState: "complete",
    hidden: true,
    visibilityState: "hidden",
    hasFocus: () => false,
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return {}; },
  };
  const sandbox = {
    __dirname: path.join(APP_DIR, "src"),
    window: windowStub,
    document: documentStub,
    location: { hostname: host, protocol: "https:" },
    marker,
    console: { error() {}, log() {} },
    Promise,
    JSON,
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    require(name) {
      if (name === "electron") {
        return {
          ipcRenderer: {
            invoke(channel, msg) {
              invocations.push({ channel, msg });
              return Promise.resolve({ ok: true });
            },
            on() {},
          },
          webFrame: {
            insertCSS(css) { insertedCss.push(css); },
            executeJavaScript(code) { mainWorldScripts.push(code); return Promise.resolve(); },
          },
        };
      }
      if (name === "fs") {
        return {
          readFileSync(rel) {
            const name = path.basename(String(rel));
            if (name === "overlay.css") return "body{}";
            if (name === "main.js") {
              // Seeing the three top-level bindings proves all four sources
              // were concatenated into one eval, not run as separate scripts.
              return "marker.sawChrome = typeof chrome;" +
                "marker.sawBindings = [typeof ZS, typeof ZSParse, typeof ZSProvider].join(',');" +
                "marker.toolReply = chrome.runtime.sendMessage({type:'call_tool',name:'echo'});";
            }
            if (name === "config.js") return 'const ZS = { id: "fake" }; marker.files.push("config.js");';
            if (name === "parser.js") return 'const ZSParse = {}; marker.files.push("parser.js");';
            return `const ZSProvider = {}; marker.files.push(${JSON.stringify(name)});`;
          },
        };
      }
      if (name === "path") return path;
      throw new Error("unexpected require: " + name);
    },
  };
  windowStub.top = windowStub;
  vm.runInNewContext(preloadSource, sandbox, { filename: "preload.js" });
  return { invocations, mainWorldScripts, insertedCss, windowStub };
}

// Static guarantee: the AI-site BrowserView, not the toolbar window, must
// isolate worlds. Match the block that carries the extension preload.
const viewStart = mainSource.indexOf("new BrowserView({");
assert.ok(viewStart >= 0, "AI BrowserView must exist");
const viewBlock = mainSource.slice(viewStart, mainSource.indexOf("});", viewStart));
assert.match(viewBlock, /contextIsolation:\s*true/, "AI view must use contextIsolation: true");
assert.doesNotMatch(preloadSource, /window\.chrome\s*=/, "shim must not be assigned to window");
assert.doesNotMatch(
  preloadSource,
  /Object\.defineProperty\(\s*window\s*,\s*["']chrome["']/,
  "shim must not be defined on window",
);

const marker = { files: [] };
const result = runPreload("chat.deepseek.com", marker);

// Page world gets no privileged API at all.
assert.strictEqual(result.windowStub.chrome, undefined, "page world must not see chrome");
assert.strictEqual(typeof result.windowStub.ipcRenderer, "undefined", "page world must not see ipcRenderer");

// Content scripts run in the isolated world and still see the shim lexically.
assert.strictEqual(marker.sawChrome, "object", "content scripts must see the chrome shim");
assert.strictEqual(marker.sawBindings, "object,object,object", "content scripts must share one eval scope");
assert.deepStrictEqual(marker.files, ["config.js", "parser.js", "deepseek.js"], "content scripts injected in order");
assert.strictEqual(result.invocations.length, 1, "content scripts must be able to call the bridge");
assert.strictEqual(result.invocations[0].channel, "zs:runtime");
assert.strictEqual(result.invocations[0].msg.type, "call_tool");
assert.strictEqual(result.insertedCss.length, 1, "overlay CSS must still be injected");

// No per-site main-world helper on deepseek: content scripts must not be sent
// to the page world through webFrame.executeJavaScript.
assert.strictEqual(result.mainWorldScripts.length, 0, "content scripts must not run in the page world");

// Sites with a main-world helper keep it there; the shim stays isolated.
const marker2 = { files: [] };
const withHelper = runPreload("chatgpt.com", marker2);
assert.strictEqual(withHelper.mainWorldScripts.length, 1, "main-world helper still injected");
assert.strictEqual(withHelper.windowStub.chrome, undefined, "shim stays hidden with a main-world helper");
assert.deepStrictEqual(marker2.files, ["config.js", "parser.js", "chatgpt.js"]);

console.log("PASS world-isolation checks: page world isolated, content scripts keep tool access");
