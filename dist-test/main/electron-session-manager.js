"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.profilePartitionPrefix = exports.defaultProfileId = void 0;
exports.getElectronSession = getElectronSession;
exports.getDefaultProfileSession = getDefaultProfileSession;
exports.flushElectronSession = flushElectronSession;
exports.createDefaultProfilePartition = createDefaultProfilePartition;
exports.createProfilePartition = createProfilePartition;
exports.createSessionPartition = createSessionPartition;
const electron_1 = require("electron");
exports.defaultProfileId = "default";
exports.profilePartitionPrefix = "persist:profile-";
function getElectronSession(siteId, sessionId) {
    return electron_1.session.fromPartition(createSessionPartition(siteId, sessionId));
}
function getDefaultProfileSession() {
    return electron_1.session.fromPartition(createDefaultProfilePartition());
}
async function flushElectronSession(targetSession) {
    targetSession.flushStorageData();
    await targetSession.cookies.flushStore();
}
function createDefaultProfilePartition() {
    return createProfilePartition(exports.defaultProfileId);
}
function createProfilePartition(profileId) {
    return `${exports.profilePartitionPrefix}${profileId}`;
}
function createSessionPartition(siteId, sessionId) {
    return `persist:site-${siteId}-session-${sessionId}`;
}
