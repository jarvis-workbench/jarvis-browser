"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const navigation_target_1 = require("../../main/browser-host/navigation-target");
(0, node_test_1.default)("adds https prefix for bare hostnames", () => {
    strict_1.default.deepEqual((0, navigation_target_1.resolveNavigationTarget)("example.com"), {
        kind: "browser",
        url: "https://example.com/",
    });
});
(0, node_test_1.default)("adds https prefix for localhost with port", () => {
    strict_1.default.deepEqual((0, navigation_target_1.resolveNavigationTarget)("localhost:3000"), {
        kind: "browser",
        url: "https://localhost:3000/",
    });
});
(0, node_test_1.default)("keeps data urls in browser navigation", () => {
    const result = (0, navigation_target_1.resolveNavigationTarget)("data:image/png;base64,AAAA");
    strict_1.default.equal(result.kind, "browser");
    strict_1.default.equal(result.url, "data:image/png;base64,AAAA");
});
(0, node_test_1.default)("keeps file urls in browser navigation", () => {
    strict_1.default.deepEqual((0, navigation_target_1.resolveNavigationTarget)("file:///tmp/a.png"), {
        kind: "browser",
        url: "file:///tmp/a.png",
    });
});
(0, node_test_1.default)("keeps about blank in browser navigation", () => {
    strict_1.default.deepEqual((0, navigation_target_1.resolveNavigationTarget)("about:blank"), {
        kind: "browser",
        url: "about:blank",
    });
});
(0, node_test_1.default)("routes mailto to external handler", () => {
    strict_1.default.deepEqual((0, navigation_target_1.resolveNavigationTarget)("mailto:test@example.com"), {
        kind: "external",
        url: "mailto:test@example.com",
    });
});
(0, node_test_1.default)("routes custom schemes to external handler", () => {
    strict_1.default.deepEqual((0, navigation_target_1.resolveNavigationTarget)("weixin://dl/chat"), {
        kind: "external",
        url: "weixin://dl/chat",
    });
});
(0, node_test_1.default)("blocks malformed urls", () => {
    const result = (0, navigation_target_1.resolveNavigationTarget)("not a real url %%");
    strict_1.default.equal(result.kind, "blocked");
    strict_1.default.match(result.errorText, /无法识别/);
});
