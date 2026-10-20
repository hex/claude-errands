// ABOUTME: Types for the #ws import. The code that runs is the vendored copy in vendor/ws; these types come
// ABOUTME: from @types/ws, a dev dependency, so the plugin needs no node_modules at run time.
export { default, WebSocketServer, WebSocket, createWebSocketStream, Receiver, Sender } from 'ws'
