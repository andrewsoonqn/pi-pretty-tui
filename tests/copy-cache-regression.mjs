import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// An optional host entry tests the same Pi version that loads the extension,
// without changing the development dependencies.
const hostEntry = process.argv[2] ?? fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const hostRequire = createRequire(hostEntry);
const tuiEntry = hostRequire.resolve("@earendil-works/pi-tui");
const core = await import(hostEntry);
const tui = await import(tuiEntry);
const { renderLayoutFrame } = await import(join(dirname(tuiEntry), "layout.js"));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
core.initTheme("dark", false);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": hostEntry,
    "@earendil-works/pi-tui": tuiEntry,
  },
});
const extension = await jiti.import(join(projectRoot, "extensions/index.ts"), { default: true });
const handlers = new Map();
extension({
  on(name, handler) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  },
  registerCommand() {},
  registerTool() {},
  registerEntryRenderer() {},
});
const copies = [];
try {
  // Capture the host UI before the intentionally minimal session stub stops.
  core.InteractiveMode.prototype.renderSessionEntries.call({
    ui: { mode: "fullscreen", async copyTextToClipboard(text) { copies.push(text); } },
  }, []);
} catch {}

const message = (text) => ({
  role: "assistant", timestamp: 1, stopReason: "stop",
  content: [{ type: "text", text }],
});
const source = (prefix, codes) => `${prefix}\n\n${codes.map((code) => `\`\`\`sh\n${code}\n\`\`\``).join("\n\n")}`;
const codes = ['printf "first"', '  printf "second"\nprintf "第三"', 'printf "first"'];
const component = new core.AssistantMessageComponent(message(source("Initial", codes)));
const screen = Object.create(tui.TuiAltScreen.prototype);
screen.terminal = { columns: 80, rows: 40 };
screen.overlayStack = [];
screen.requestRender = () => {};
screen.handleSearchMouseEvent = () => false;
screen.dispatchMouseToOverlay = () => ({ hit: false });
screen.handleScrollToEndIndicatorMouseEvent = () => false;
screen.handleScrollbarMouseEvent = () => false;
screen.updateScrollbarHover = () => {};
screen.stopSelectionAutoScroll = () => {};
screen.handleRightClickPaste = () => false;
screen.handleSelectionMouseEvent = () => {};

let scenarios = 0;
const checkCopies = (width, expected) => {
  screen.terminal.columns = width;
  screen.currentLayout = renderLayoutFrame(component, width, 40, () => {});
  const lines = screen.currentLayout.lines.map(tui.stripTerminalSequences);
  const buttons = lines.flatMap((line, y) => line.includes("[Copy]")
    ? [{ x: line.indexOf("[Copy]") + 1, y }] : []);
  assert.equal(buttons.length, expected.length, "Every code block must keep its Copy button");
  const before = copies.length;
  for (const { x, y } of buttons) {
    screen.handleMouseEvent({ button: 0, x, y, release: false });
    screen.handleMouseEvent({ button: 0, x, y, release: true });
  }
  assert.deepEqual(copies.slice(before), expected, "Visible buttons must copy their own exact code after updates");
  scenarios++;
};

try {
  checkCopies(70, codes);
  component.updateContent(message(source("Initial", codes)));
  checkCopies(70, codes);
  component.updateContent(message(source("Changed prose\nwith an extra line", codes)));
  checkCopies(70, codes);
  const reordered = [codes[1], 'printf "replacement"', codes[0]];
  component.updateContent(message(source("Reordered", reordered)));
  checkCopies(70, reordered);
  checkCopies(32, reordered);
  component.invalidate();
  checkCopies(32, reordered);
  checkCopies(70, reordered);
  component.updateContent(message("No remaining code blocks"));
  checkCopies(70, []);
  console.log(`PASS: ${scenarios} fullscreen update/resize scenarios, ${copies.length} exact code copies`);
} finally {
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, {});
}
