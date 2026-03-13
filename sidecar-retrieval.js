/**
 * TunnelVision Sidecar Auto-Retrieval
 * Pre-generation tree navigation via the sidecar LLM.
 *
 * Before each chat generation, this module:
 *   1. Builds a collapsed tree overview of all active lorebooks
 *   2. Extracts recent chat context (last N messages)
 *   3. Sends both to the sidecar LLM asking it to pick relevant node IDs
 *   4. Resolves those node IDs to entry content
 *   5. Injects the content via setExtensionPrompt
 *
 * Works alongside (not replacing) the chat model's tool access — the chat model
 * can still call TunnelVision_Search for additional retrieval or write tools.
 */

import { getContext } from '../../../st-context.js';
import { extension_prompt_types, extension_prompt_roles, setExtensionPrompt } from '../../../../script.js';
import { loadWorldInfo } from '../../../world-info.js';
import {
    getTree,
    findNodeById,
    getAllEntryUids,
    getSettings,
} from './tree-store.js';
import { getReadableBooks } from './tool-registry.js';
import { isSidecarConfigured, sidecarGenerate, getSidecarModelLabel } from './llm-sidecar.js';
import { logSidecarRetrieval, setSidecarActive } from './activity-feed.js';

const TV_SIDECAR_RETRIEVAL_KEY = 'tunnelvision_sidecar_retrieval';

// ─── Tree Overview (reuses collapsed-tree format from search.js) ─────

/**
 * Build a compact collapsed tree overview for the sidecar prompt.
 * Similar to buildCollapsedTreeOverview in search.js but kept independent
 * to avoid circular imports and to allow sidecar-specific formatting.
 * @returns {string}
 */
function buildSidecarTreeOverview() {
    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return '';

    let overview = '';
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree?.root) continue;

        overview += `Lorebook: ${bookName}\n`;
        overview += formatNodeForSidecar(tree.root, 0, true);
        overview += '\n';
    }

    // Cap to avoid blowing sidecar context
    const maxLen = 5000;
    if (overview.length > maxLen) {
        overview = overview.substring(0, maxLen - 80) + '\n  ... (tree truncated)\n';
    }

    return overview;
}

/**
 * Recursively format a node for the sidecar's tree view.
 * @param {Object} node
 * @param {number} depth
 * @param {boolean} isRoot
 * @returns {string}
 */
function formatNodeForSidecar(node, depth, isRoot = false) {
    const indent = '  '.repeat(depth);
    const children = node.children || [];
    const directEntries = (node.entryUids || []).length;
    const totalEntries = getAllEntryUids(node).length;
    let text = '';

    if (isRoot) {
        if (directEntries > 0) {
            text += `${indent}[${node.id}] ROOT (${directEntries} entries)\n`;
        }
    } else {
        const isLeaf = children.length === 0;
        const type = isLeaf ? 'leaf' : 'branch';
        text += `${indent}[${node.id}] ${node.label || 'Unnamed'} [${type}] (${totalEntries} entries)\n`;
        if (node.summary) {
            text += `${indent}  ${node.summary}\n`;
        }
    }

    for (const child of children) {
        text += formatNodeForSidecar(child, depth + 1, false);
    }

    return text;
}

// ─── Chat Context Extraction ─────────────────────────────────────

/**
 * Extract recent chat messages for sidecar context.
 * @param {number} maxMessages
 * @returns {string}
 */
function extractRecentChat(maxMessages = 10) {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return '';

    const lines = [];
    const start = Math.max(0, chat.length - maxMessages);

    for (let i = start; i < chat.length; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        const role = msg.is_user ? 'User' : 'Character';
        const text = (msg.mes || '').substring(0, 500).replace(/\n/g, ' ');
        if (text.trim()) {
            lines.push(`${role}: ${text}`);
        }
    }

    return lines.join('\n');
}

// ─── Node Resolution ─────────────────────────────────────────────

/**
 * Resolve node IDs to entry content across all active lorebooks.
 * @param {string[]} nodeIds
 * @returns {Promise<string>}
 */
async function resolveNodeContent(nodeIds) {
    const results = [];
    const seenEntries = new Set();

    for (const nodeId of nodeIds) {
        for (const bookName of getReadableBooks()) {
            const tree = getTree(bookName);
            if (!tree?.root) continue;

            const node = findNodeById(tree.root, nodeId);
            if (!node) continue;

            const uids = getAllEntryUids(node);
            const bookData = await loadWorldInfo(bookName);
            if (!bookData?.entries) continue;

            for (const uid of uids) {
                const entryKey = `${bookName}:${uid}`;
                if (seenEntries.has(entryKey)) continue;
                seenEntries.add(entryKey);

                const entry = findEntryByUid(bookData.entries, uid);
                if (!entry?.content || entry.disable) continue;

                const title = entry.comment || entry.key?.[0] || `Entry #${uid}`;
                results.push(`[${bookName} | ${title}]\n${entry.content}`);
            }
        }
    }

    return results.join('\n\n');
}

/**
 * Find an entry by UID in a lorebook's entries object.
 * @param {Object} entries
 * @param {number} uid
 * @returns {Object|null}
 */
function findEntryByUid(entries, uid) {
    for (const key of Object.keys(entries)) {
        if (entries[key].uid === uid) return entries[key];
    }
    return null;
}

// ─── Sidecar Prompt ──────────────────────────────────────────────

const SIDECAR_SYSTEM_PROMPT = `You are a retrieval assistant. Given a knowledge tree index and recent conversation, pick the most relevant node IDs to retrieve for the next response.

Rules:
- Return ONLY a JSON object with two fields:
  1. "reasoning": A single sentence explaining why these nodes are relevant
  2. "nodes": An array of node ID strings
- Example: {"reasoning": "The conversation mentions Charlie's relationship with Jonas", "nodes": ["tv_123_abc"]}
- Pick 1-5 nodes maximum — prefer specific leaf nodes over broad branches
- Pick nodes whose content would be most useful for the next character response
- If nothing seems relevant, return: {"reasoning": "No relevant nodes found", "nodes": []}
- Do NOT include any explanation outside the JSON object`;

/**
 * Build the sidecar retrieval prompt.
 * @param {string} treeOverview
 * @param {string} recentChat
 * @returns {string}
 */
function buildRetrievalPrompt(treeOverview, recentChat) {
    return `KNOWLEDGE TREE INDEX:
${treeOverview}

RECENT CONVERSATION:
${recentChat}

Which node IDs should be retrieved to provide relevant context for the next response? Return a JSON array of node IDs.`;
}

// ─── Parse Response ──────────────────────────────────────────────

/**
 * Parse the sidecar's response to extract node IDs and reasoning.
 * Handles JSON object format (preferred) and legacy JSON array format.
 * @param {string} response
 * @returns {{ nodeIds: string[], reasoning: string }}
 */
function parseSidecarResponse(response) {
    if (!response || typeof response !== 'string') return { nodeIds: [], reasoning: '' };

    // Try JSON object format first (preferred)
    const objMatch = response.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try {
            const parsed = JSON.parse(objMatch[0]);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.nodes)) {
                const nodeIds = parsed.nodes
                    .filter(id => typeof id === 'string' && id.startsWith('tv_'))
                    .slice(0, 5);
                const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
                return { nodeIds, reasoning };
            }
        } catch {
            // fall through
        }
    }

    // Fall back to legacy array format
    const arrayMatch = response.match(/\[[\s\S]*?\]/);
    if (!arrayMatch) return { nodeIds: [], reasoning: '' };

    try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (!Array.isArray(parsed)) return { nodeIds: [], reasoning: '' };
        const nodeIds = parsed.filter(id => typeof id === 'string' && id.startsWith('tv_')).slice(0, 5);
        return { nodeIds, reasoning: '' };
    } catch {
        return { nodeIds: [], reasoning: '' };
    }
}

// ─── Main Entry Point ────────────────────────────────────────────

/**
 * Run sidecar auto-retrieval before a generation.
 * Called from onGenerationStarted in index.js.
 *
 * @returns {Promise<void>}
 */
export async function runSidecarRetrieval() {
    const settings = getSettings();

    // Guard: must be enabled and sidecar must be configured
    if (!settings.sidecarAutoRetrieval) return;
    if (!isSidecarConfigured()) {
        console.debug('[TunnelVision] Sidecar auto-retrieval enabled but no sidecar configured — skipping');
        return;
    }

    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return;

    // Build tree overview
    const treeOverview = buildSidecarTreeOverview();
    if (!treeOverview.trim()) {
        console.debug('[TunnelVision] Sidecar auto-retrieval: no tree content to navigate');
        return;
    }

    // Extract recent chat
    const contextMessages = settings.sidecarContextMessages ?? 10;
    const recentChat = extractRecentChat(contextMessages);
    if (!recentChat.trim()) {
        console.debug('[TunnelVision] Sidecar auto-retrieval: no recent chat context');
        return;
    }

    setSidecarActive(true);
    try {
        // Ask sidecar LLM to pick relevant nodes
        const prompt = buildRetrievalPrompt(treeOverview, recentChat);
        const response = await sidecarGenerate({
            prompt,
            systemPrompt: SIDECAR_SYSTEM_PROMPT,
        });

        const { nodeIds, reasoning } = parseSidecarResponse(response);
        if (nodeIds.length === 0) {
            console.log('[TunnelVision] Sidecar auto-retrieval: no relevant nodes selected');
            clearRetrievalPrompt(settings);
            return;
        }

        // Resolve node IDs to entry content
        const content = await resolveNodeContent(nodeIds);
        if (!content.trim()) {
            console.log(`[TunnelVision] Sidecar auto-retrieval: ${nodeIds.length} node(s) selected but no content resolved`);
            clearRetrievalPrompt(settings);
            return;
        }

        // Inject into context — reuse mandatory prompt position/depth/role settings
        const position = mapPosition(settings.mandatoryPromptPosition);
        const depth = settings.mandatoryPromptDepth ?? 1;
        const role = mapRole(settings.mandatoryPromptRole);

        const injectionText = `[TunnelVision Auto-Retrieved Context]\n${content}`;

        // Cap injection size to avoid blowing context (~4 chars per token estimate)
        const maxChars = (settings.sidecarMaxInjectionTokens ?? 4000) * 4;
        const capped = injectionText.length > maxChars
            ? injectionText.substring(0, maxChars) + '\n[... content truncated]'
            : injectionText;

        setExtensionPrompt(TV_SIDECAR_RETRIEVAL_KEY, capped, position, depth, false, role);

        // Resolve node labels for the feed
        const nodeLabels = nodeIds.map(id => {
            for (const bookName of activeBooks) {
                const tree = getTree(bookName);
                if (!tree?.root) continue;
                const node = findNodeById(tree.root, id);
                if (node) return node.label || id;
            }
            return id;
        });

        const _modelLabel = getSidecarModelLabel() || 'unknown';
        console.log(`[TunnelVision] Sidecar auto-retrieval [${_modelLabel}]: injected ${nodeIds.length} node(s) (~${capped.length} chars)`);
        logSidecarRetrieval({ nodeIds, nodeLabels, charCount: capped.length, reasoning });

        // Detailed console output for sidecar transparency
        console.groupCollapsed(`[TunnelVision] Sidecar retrieval details (${_modelLabel})`);
        console.log('Model:', _modelLabel);
        if (reasoning) console.log('Reasoning:', reasoning);
        console.log('Selected nodes:', nodeIds.map((id, i) => `${id} → "${nodeLabels[i] || id}"`));
        console.log('Content preview:', content.substring(0, 500) + (content.length > 500 ? '...' : ''));
        console.log(`Total chars: ${capped.length} (~${Math.round(capped.length / 4)} tokens)`);
        console.groupEnd();
    } catch (error) {
        console.error('[TunnelVision] Sidecar auto-retrieval failed:', error);
        clearRetrievalPrompt(settings);
    } finally {
        setSidecarActive(false);
    }
}

/**
 * Clear the sidecar retrieval prompt (no content to inject).
 * @param {Object} settings
 */
function clearRetrievalPrompt(settings) {
    const position = mapPosition(settings.mandatoryPromptPosition);
    const depth = settings.mandatoryPromptDepth ?? 1;
    const role = mapRole(settings.mandatoryPromptRole);
    setExtensionPrompt(TV_SIDECAR_RETRIEVAL_KEY, '', position, depth, false, role);
}

/**
 * Map position setting to ST enum.
 * @param {string} val
 * @returns {number}
 */
function mapPosition(val) {
    switch (val) {
        case 'in_prompt': return extension_prompt_types.IN_PROMPT;
        case 'in_chat':
        default: return extension_prompt_types.IN_CHAT;
    }
}

/**
 * Map role setting to ST enum.
 * @param {string} val
 * @returns {number}
 */
function mapRole(val) {
    switch (val) {
        case 'user': return extension_prompt_roles.USER;
        case 'assistant': return extension_prompt_roles.ASSISTANT;
        case 'system':
        default: return extension_prompt_roles.SYSTEM;
    }
}
