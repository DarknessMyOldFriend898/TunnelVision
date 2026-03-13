/**
 * TunnelVision - Reasoning-Based Lorebook Retrieval
 *
 * Replaces keyword-based lorebook activation with LLM-driven hierarchical
 * tree search via tool calls. The model navigates a tree index to find
 * contextually relevant entries instead of relying on brittle keyword triggers.
 *
 * Architecture:
 *   index.js        — Lean orchestrator (this file). Init, events, wiring only.
 *   tree-store.js   — Tree data structure, CRUD, serialization.
 *   tree-builder.js — Auto-build trees from metadata or LLM.
 *   tool-registry.js— ToolManager registration for all TunnelVision tools.
 *   tools/          — One file per tool (search, remember, update, forget, reorganize, notebook).
 *   entry-manager.js— Lorebook CRUD operations shared by memory tools.
 *   ui-controller.js— Settings panel rendering, tree editor, drag-and-drop.
 *   diagnostics.js  — Failure point checks and auto-fixes.
 *   commands.js     — !command syntax interceptor (summarize, remember, search, forget, ingest).
 *   auto-summary.js — Automatic summary injection every N messages.
 */

import { eventSource, event_types, extension_prompt_types, extension_prompt_roles, setExtensionPrompt } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { ToolManager } from '../../../tool-calling.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { getSettings, isLorebookEnabled } from './tree-store.js';
import { preflightToolRuntimeState, registerTools } from './tool-registry.js';
import { buildNotebookPrompt } from './tools/notebook.js';
import { bindUIEvents, refreshUI } from './ui-controller.js';
import { initActivityFeed } from './activity-feed.js';
import { initCommands } from './commands.js';
import { initAutoSummary } from './auto-summary.js';
import { runSidecarRetrieval } from './sidecar-retrieval.js';
import { runSidecarWriter } from './sidecar-writer.js';

const EXTENSION_NAME = 'tunnelvision';
const EXTENSION_FOLDER = `third-party/TunnelVision`;

// Guard: prevents tool re-registration when WORLDINFO_UPDATED fires during generation
// (lorebook saves from tool actions trigger this event mid-generation).
let _generationInProgress = false;

async function init() {
    // Ensure settings exist
    getSettings();

    // Render settings panel
    const settingsHtml = $(await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings'));
    const container = document.getElementById('extensions_settings2');
    if (container) {
        container.appendChild(settingsHtml[0]);
    } else {
        console.error('[TunnelVision] Could not find extensions_settings2 container');
        return;
    }

    // Bind UI events
    bindUIEvents();

    // Initialize activity feed (listens for tool call events)
    initActivityFeed();

    // Wire up !command interception
    initCommands();

    // Wire up auto-summary interval tracking
    initAutoSummary();

    // Load initial state
    refreshUI();

    // Apply recurse limit override and register tools
    const settings = getSettings();
    applyRecurseLimit(settings);
    if (settings.globalEnabled !== false) {
        await registerTools();
    }

    // Listen for relevant events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.WORLDINFO_UPDATED, onWorldInfoUpdated);
    if (event_types.WORLDINFO_SETTINGS_UPDATED) {
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, onWorldInfoUpdated);
    }
    eventSource.on(event_types.APP_READY, onAppReady);

    // Suppress normal WI keyword scanning for TV-managed lorebooks
    if (event_types.WORLDINFO_ENTRIES_LOADED) {
        eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded);
        console.debug('[TunnelVision] WI suppression listener registered');
    } else {
        console.warn('[TunnelVision] WORLDINFO_ENTRIES_LOADED event not found, WI suppression disabled');
    }

    // Inject mandatory tool call instruction when enabled
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    }

    // Clear generation guard when generation ends (covers abort/stop paths).
    // MESSAGE_RECEIVED already clears it for the normal completion path.
    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => { _generationInProgress = false; window.TunnelVision_isRecursiveToolPass = false; });
    } else {
        if (event_types.GENERATION_STOPPED) {
            eventSource.on(event_types.GENERATION_STOPPED, () => { _generationInProgress = false; window.TunnelVision_isRecursiveToolPass = false; });
        }
    }

    // Post-generation sidecar writer (remember/update after model responds)
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    }

    // Clean up orphaned tool invocations when messages are deleted
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, cleanOrphanedToolInvocations);
    }

    // Refresh connection profile dropdown when profiles change
    if (event_types.CONNECTION_PROFILE_CREATED) {
        eventSource.on(event_types.CONNECTION_PROFILE_CREATED, () => refreshUI());
    }
    if (event_types.CONNECTION_PROFILE_DELETED) {
        eventSource.on(event_types.CONNECTION_PROFILE_DELETED, () => refreshUI());
    }
    if (event_types.CONNECTION_PROFILE_UPDATED) {
        eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, () => refreshUI());
    }

    console.log('[TunnelVision] Extension loaded');
}

async function onChatChanged() {
    refreshUI();
    await registerTools();
}

async function onWorldInfoUpdated() {
    refreshUI();
    if (_generationInProgress) {
        console.debug('[TunnelVision] Skipping tool re-registration during active generation');
        return;
    }
    await registerTools();
}

async function onAppReady() {
    await registerTools();
}

/**
 * Suppress normal WI keyword scanning for entries belonging to TV-managed lorebooks.
 * TV retrieves these entries via tool calls instead — letting them also trigger via
 * keywords would double-inject them into context.
 * @param {{ globalLore: Array, characterLore: Array, chatLore: Array, personaLore: Array }} data
 */
function onWorldInfoEntriesLoaded(data) {
    const settings = getSettings();
    if (settings.globalEnabled === false) return;

    const passthrough = settings.passthroughConstant !== false;
    let removed = 0;
    let passed = 0;
    const filterTvEntries = (arr) => {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].world && isLorebookEnabled(arr[i].world)) {
                // Let constant (always-active) entries through if the toggle is on
                if (passthrough && arr[i].constant) {
                    passed++;
                    continue;
                }
                arr.splice(i, 1);
                removed++;
            }
        }
    };

    filterTvEntries(data.globalLore);
    filterTvEntries(data.characterLore);
    filterTvEntries(data.chatLore);
    filterTvEntries(data.personaLore);

    if (removed > 0 || passed > 0) {
        console.log(`[TunnelVision] Suppressed ${removed} TV-managed entries from normal WI scanning` + (passed > 0 ? `, passed through ${passed} constant entries` : ''));
    }
}

const TV_PROMPT_KEY = 'tunnelvision_mandatory';
const TV_NOTEBOOK_KEY = 'tunnelvision_notebook';

/**
 * Map a position setting string to the ST extension_prompt_types enum.
 */
function mapPositionSetting(val) {
    switch (val) {
        case 'in_prompt': return extension_prompt_types.IN_PROMPT;
        case 'in_chat':
        default: return extension_prompt_types.IN_CHAT;
    }
}

/**
 * Map a role setting string to the ST extension_prompt_roles enum.
 */
function mapRoleSetting(val) {
    switch (val) {
        case 'user': return extension_prompt_roles.USER;
        case 'assistant': return extension_prompt_roles.ASSISTANT;
        case 'system':
        default: return extension_prompt_roles.SYSTEM;
    }
}

/**
 * Strip TunnelVision tool results from older chat messages to save context tokens.
 * Only strips tools in the user-configured filter list. Notebook is always immune
 * (its results are action confirmations, not retrievable data).
 * Only strips from messages before the last user message (current turn is preserved).
 * Mutates chat data permanently — results cannot be recovered.
 */
function stripOldToolResults() {
    const settings = getSettings();
    const filterList = settings.ephemeralToolFilter;
    if (!Array.isArray(filterList) || filterList.length === 0) return;

    // Notebook is always immune — it stores action confirmations the model needs
    const strippable = new Set(filterList.filter(n => n !== 'TunnelVision_Notebook'));
    if (strippable.size === 0) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 2) return;

    // Find the last user message index — everything before it is "old"
    let lastUserIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user) { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 1) return;

    let stripped = 0;
    for (let i = 0; i < lastUserIdx; i++) {
        const invocations = chat[i]?.extra?.tool_invocations;
        if (!Array.isArray(invocations)) continue;

        for (const inv of invocations) {
            if (!inv.name || !strippable.has(inv.name)) continue;
            if (!inv.result || inv.result === ' ') continue;
            inv.result = ' ';
            stripped++;
        }
    }

    if (stripped > 0) {
        console.log(`[TunnelVision] Ephemeral mode: cleared ${stripped} old tool result(s) from context`);
    }
}

/**
 * Remove orphaned tool_invocations system messages from the tail of the chat.
 * After a regenerate or delete, the chat may end with one or more tool_invocations
 * system messages whose parent assistant reply no longer exists. These orphans cause
 * the API to receive tool_result blocks without matching tool_use blocks, producing
 * errors like "unexpected tool_use_id" (Anthropic) or "function call turn" (OpenAI).
 *
 * Walks backward from the end of chat and removes any trailing is_system messages
 * that carry tool_invocations. Stops as soon as it hits a non-tool-invocation message.
 */
function cleanOrphanedToolInvocations() {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 2) return;

    let removed = 0;
    while (chat.length > 1) {
        const last = chat[chat.length - 1];
        if (!last.is_system || !Array.isArray(last.extra?.tool_invocations)) break;

        // This is an orphaned tool_invocations message at the tail -- remove it
        chat.length = chat.length - 1;
        removed++;
    }

    if (removed > 0) {
        console.log(`[TunnelVision] Removed ${removed} orphaned tool_invocations message(s) from chat tail`);
    }
}

/**
 * Inject or clear the mandatory tool call system prompt before each generation.
 * Runs before ST assembles the next request, so it can validate TV tool state first.
 */
async function onGenerationStarted(type, opts, dryRun) {
    _generationInProgress = true;

    // Skip dry runs (ST's token counting passes) — no sidecar calls or heavy work needed.
    if (dryRun) return;

    // Detect recursive tool-call passes FIRST, before any other work.
    // On recursive passes the last message is a tool_invocations system message
    // containing the tool results the model needs. We must NOT touch it.
    const context = getContext();
    const lastMsg = context.chat?.[context.chat.length - 1];
    const isRecursiveToolPass = lastMsg?.extra?.tool_invocations != null;

    // Expose recursive state globally so presets, macros, and other extensions can
    // skip work during recursive tool passes.
    window.TunnelVision_isRecursiveToolPass = isRecursiveToolPass;

    // On recursive passes, clear the mandatory tool prompt so the model isn't
    // told "you MUST call a tool" when it already has tool results and should
    // be writing the actual response. Then skip all other heavy work.
    if (isRecursiveToolPass) {
        setExtensionPrompt(TV_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }

    const settings = getSettings();
    let runtimeState = null;

    // Clean up orphaned tool_invocations at the tail of chat (caused by
    // regenerate or message deletion leaving tool result messages without
    // a matching assistant reply). Only on first pass — on recursive passes
    // the tail message IS the active tool result, not an orphan.
    cleanOrphanedToolInvocations();

    if (settings.globalEnabled !== false) {
        runtimeState = await preflightToolRuntimeState({ repair: true, reason: 'generation', log: true });
    }

    // Ephemeral mode: strip old TunnelVision tool results from context
    if (settings.ephemeralResults) {
        stripOldToolResults();
    }

    // Sidecar auto-retrieval: pre-fetch relevant entries before generation (first pass only)
    if (settings.sidecarAutoRetrieval && settings.globalEnabled !== false) {
        try {
            await runSidecarRetrieval();
        } catch (err) {
            console.error('[TunnelVision] Sidecar auto-retrieval error:', err);
        }
    }

    // Mandatory tool call instruction (only on first pass, not recursive)
    const mandatoryPosition = mapPositionSetting(settings.mandatoryPromptPosition);
    const mandatoryDepth = settings.mandatoryPromptDepth ?? 1;
    // Guard: in_chat + user role can bisect tool_use/tool_result pairs on Claude,
    // causing "unexpected tool_use_id" API errors. Force system role in that case.
    const mandatoryRoleSetting = (settings.mandatoryPromptPosition === 'in_chat' && settings.mandatoryPromptRole === 'user')
        ? 'system' : settings.mandatoryPromptRole;
    const mandatoryRole = mapRoleSetting(mandatoryRoleSetting);

    if (
        settings.globalEnabled !== false
        && settings.mandatoryTools
        && runtimeState?.activeBooks?.length > 0
        && runtimeState.expectedToolNames.length > 0
        && runtimeState.eligibleToolNames.length > 0
    ) {
        const prompt = settings.mandatoryPromptText || '[IMPORTANT INSTRUCTION: You MUST use at least one TunnelVision tool call this turn.]';
        setExtensionPrompt(TV_PROMPT_KEY, prompt, mandatoryPosition, mandatoryDepth, false, mandatoryRole);
    } else {
        setExtensionPrompt(TV_PROMPT_KEY, '', mandatoryPosition, mandatoryDepth, false, mandatoryRole);
        if (
            settings.globalEnabled !== false
            && settings.mandatoryTools
            && runtimeState
            && runtimeState.activeBooks.length > 0
            && runtimeState.expectedToolNames.length > 0
            && runtimeState.eligibleToolNames.length === 0
        ) {
            console.warn('[TunnelVision] Mandatory tools enabled, but no eligible TunnelVision tools are available for this generation.');
        }
    }

    // Inject notebook contents every turn (if enabled and notes exist)
    const notebookPosition = mapPositionSetting(settings.notebookPromptPosition);
    const notebookDepth = settings.notebookPromptDepth ?? 1;
    const notebookRoleSetting = (settings.notebookPromptPosition === 'in_chat' && settings.notebookPromptRole === 'user')
        ? 'system' : settings.notebookPromptRole;
    const notebookRole = mapRoleSetting(notebookRoleSetting);

    if (settings.globalEnabled !== false && settings.notebookEnabled !== false) {
        const notebookPrompt = buildNotebookPrompt();
        setExtensionPrompt(TV_NOTEBOOK_KEY, notebookPrompt, notebookPosition, notebookDepth, false, notebookRole);
    } else {
        setExtensionPrompt(TV_NOTEBOOK_KEY, '', notebookPosition, notebookDepth, false, notebookRole);
    }
}

/**
 * Post-generation handler: run sidecar writer if enabled.
 * Fires after the chat model's response is received (MESSAGE_RECEIVED).
 */
async function onMessageReceived() {
    // Clear generation guards BEFORE the sidecar writer runs, so that lorebook
    // writes triggered by the writer do not get blocked by the generation guard.
    _generationInProgress = false;
    window.TunnelVision_isRecursiveToolPass = false;

    const settings = getSettings();
    if (!settings.sidecarPostGenWriter || settings.globalEnabled === false) return;

    try {
        await runSidecarWriter();
    } catch (err) {
        console.error('[TunnelVision] Sidecar post-gen writer error:', err);
    }
}

/**
 * Apply the user's RECURSE_LIMIT override to ToolManager.
 * Only overrides when the user has set a value different from the default (5).
 * Stores the original value so we can restore on disable.
 * @param {Object} settings
 */
const ST_DEFAULT_RECURSE_LIMIT = 5;
function applyRecurseLimit(settings) {
    const limit = Number(settings.recurseLimit);
    if (!isFinite(limit) || limit < 1) {
        ToolManager.RECURSE_LIMIT = ST_DEFAULT_RECURSE_LIMIT;
        return;
    }
    // Clamp to sane range: 1–50. Over 50 is almost certainly a mistake.
    ToolManager.RECURSE_LIMIT = Math.min(Math.max(Math.round(limit), 1), 50);
}

// Exported so ui-controller can call it when the setting changes
export { applyRecurseLimit };

// Initialize
await init();
