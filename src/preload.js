'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, handler);
  return () => ipcRenderer.removeListener(ch, handler);
};

contextBridge.exposeInMainWorld('api', {
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  models: { scan: invoke('models:scan') },
  llama: {
    start: invoke('llama:start'),
    stop: invoke('llama:stop'),
    status: invoke('llama:status'),
    checkUpdate: invoke('llama:checkUpdate'),
    update: invoke('llama:update'),
    onState: on('llama:state'),
    onUpdateProgress: on('llama:updateProgress'),
  },
  chat: {
    send: invoke('chat:send'),
    stop: invoke('chat:stop'),
    onDelta: on('chat:delta'),
    onThinking: on('chat:thinking'),
    onToolStart: on('chat:tool_start'),
    onToolEnd: on('chat:tool_end'),
    onTimings: on('chat:timings'),
    onDone: on('chat:done'),
    onError: on('chat:error'),
  },
  monitor: { onStats: on('monitor:stats') },
  mcp: {
    status: invoke('mcp:status'),
    save: invoke('mcp:save'),
    apply: invoke('mcp:apply'),
    importClaude: invoke('mcp:importClaude'),
  },
  skills: {
    list: invoke('skills:list'),
    toggle: invoke('skills:toggle'),
    install: invoke('skills:install'),
    remove: invoke('skills:remove'),
  },
  admin: {
    status: invoke('admin:status'),
    setMode: invoke('admin:setMode'),
  },
  providers: {
    list: invoke('providers:list'),
    save: invoke('providers:save'),
    setKey: invoke('providers:setKey'),
    test: invoke('providers:test'),
    fetchModels: invoke('providers:fetchModels'),
  },
  tasks: {
    list: invoke('tasks:list'),
    pickModel: invoke('tasks:pickModel'),
  },
  ingest: {
    file: invoke('ingest:file'),
    url: invoke('ingest:url'),
    pickFiles: invoke('ingest:pickFiles'),
  },
  ocr: {
    visionModels: invoke('ocr:visionModels'),
    run: invoke('ocr:run'),
  },
  tts: {
    voices: invoke('tts:voices'),
    speak: invoke('tts:speak'),
    preview: invoke('tts:preview'),
    stop: invoke('tts:stop'),
    save: invoke('tts:save'),
  },
  pickFolder: invoke('dialog:pickFolder'),
  openExternal: invoke('shell:openExternal'),
});
