import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('add-web skill package', () => {
  // --- Manifest ---

  it('has a valid manifest.yaml', () => {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    const manifest = yamlParse(raw) as Record<string, unknown>;
    expect(manifest.skill).toBe('web');
    expect(manifest.version).toBeTruthy();
    expect(manifest.description).toBeTruthy();
  });

  it('manifest declares all add files that exist', () => {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    const manifest = yamlParse(raw) as { adds: string[] };
    expect(manifest.adds.length).toBeGreaterThan(0);
    for (const addPath of manifest.adds) {
      const fullPath = path.join(SKILL_DIR, 'add', addPath);
      expect(fs.existsSync(fullPath), `add file missing: ${addPath}`).toBe(true);
    }
  });

  it('manifest declares all modify files that exist', () => {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    const manifest = yamlParse(raw) as { modifies: string[] };
    expect(manifest.modifies.length).toBeGreaterThan(0);
    for (const modPath of manifest.modifies) {
      const fullPath = path.join(SKILL_DIR, 'modify', modPath);
      expect(fs.existsSync(fullPath), `modify file missing: ${modPath}`).toBe(true);
    }
  });

  it('manifest declares env_additions', () => {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    const manifest = yamlParse(raw) as { structured: { env_additions: string[] } };
    expect(manifest.structured.env_additions).toContain('WEB_GATEWAY_PORT');
    expect(manifest.structured.env_additions).toContain('WEB_GATEWAY_TOKEN');
  });

  it('manifest has no npm dependencies', () => {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    const manifest = yamlParse(raw) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('npm_dependencies');
  });

  // --- Add files ---

  it('add/src/channels/web.ts exports WebChannel class', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'add/src/channels/web.ts'),
      'utf-8',
    );
    expect(content).toContain('export class WebChannel');
    expect(content).toContain("name = 'web'");
  });

  it('add/src/channels/web.ts does not import MessageMetadata', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'add/src/channels/web.ts'),
      'utf-8',
    );
    expect(content).not.toContain('MessageMetadata');
  });

  it('add/src/channels/web.ts sendMessage uses base signature (no metadata)', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'add/src/channels/web.ts'),
      'utf-8',
    );
    // Should have sendMessage(jid: string, text: string) without metadata param
    expect(content).toMatch(/async sendMessage\(jid: string, text: string\)/);
    expect(content).not.toMatch(/metadata\?: MessageMetadata/);
  });

  it('add/src/channels/web-ui.ts exports getWebUiHtml and getRoomListHtml', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'add/src/channels/web-ui.ts'),
      'utf-8',
    );
    expect(content).toContain('export function getWebUiHtml');
    expect(content).toContain('export function getRoomListHtml');
  });

  it('add/src/channels/web.test.ts has 17 tests (no metadata tests)', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'add/src/channels/web.test.ts'),
      'utf-8',
    );
    const itCount = (content.match(/\bit\(/g) || []).length;
    expect(itCount).toBe(17);
    // Must NOT contain metadata-specific tests
    expect(content).not.toContain('metadata.senderName');
    expect(content).not.toContain('without metadata uses default sender_name');
  });

  it('add/config-examples/nginx-web-gateway.conf has SSE settings', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'add/config-examples/nginx-web-gateway.conf'),
      'utf-8',
    );
    expect(content).toContain('proxy_buffering off');
    expect(content).toContain('proxy_read_timeout');
  });

  // --- Modify files ---

  it('modify/src/config.ts adds WEB_GATEWAY_PORT and WEB_GATEWAY_TOKEN', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/config.ts'),
      'utf-8',
    );
    expect(content).toContain("'WEB_GATEWAY_PORT'");
    expect(content).toContain("'WEB_GATEWAY_TOKEN'");
    expect(content).toContain('export const WEB_GATEWAY_PORT');
    expect(content).toContain('export const WEB_GATEWAY_TOKEN');
  });

  it('modify/src/config.ts preserves all base exports', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/config.ts'),
      'utf-8',
    );
    // All base exports must still be present
    const baseExports = [
      'ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'POLL_INTERVAL',
      'SCHEDULER_POLL_INTERVAL', 'MOUNT_ALLOWLIST_PATH', 'STORE_DIR',
      'GROUPS_DIR', 'DATA_DIR', 'MAIN_GROUP_FOLDER', 'CONTAINER_IMAGE',
      'CONTAINER_TIMEOUT', 'CONTAINER_MAX_OUTPUT_SIZE', 'IPC_POLL_INTERVAL',
      'IDLE_TIMEOUT', 'MAX_CONCURRENT_CONTAINERS', 'TRIGGER_PATTERN', 'TIMEZONE',
    ];
    for (const name of baseExports) {
      expect(content, `missing export: ${name}`).toContain(`export const ${name}`);
    }
  });

  it('modify/src/index.ts imports WebChannel and web config', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/index.ts'),
      'utf-8',
    );
    expect(content).toContain("import { WebChannel }");
    expect(content).toContain('WEB_GATEWAY_PORT');
    expect(content).toContain('WEB_GATEWAY_TOKEN');
    expect(content).toContain('STORE_DIR');
  });

  it('modify/src/index.ts types whatsapp as optional', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/index.ts'),
      'utf-8',
    );
    expect(content).toContain('WhatsAppChannel | undefined');
  });

  it('modify/src/index.ts wraps WhatsApp in try/catch with creds check', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/index.ts'),
      'utf-8',
    );
    expect(content).toContain('creds.json');
    expect(content).toContain('hasWhatsAppAuth');
  });

  it('modify/src/index.ts has web channel conditional init', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/index.ts'),
      'utf-8',
    );
    expect(content).toContain('WEB_GATEWAY_PORT > 0 && WEB_GATEWAY_TOKEN');
    expect(content).toContain('new WebChannel');
  });

  it('modify/src/index.ts auto-registers web:default', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/index.ts'),
      'utf-8',
    );
    expect(content).toContain("'web:default'");
    expect(content).toContain('hasWebRooms');
  });

  it('modify/src/index.ts does NOT import MessageMetadata', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/index.ts'),
      'utf-8',
    );
    expect(content).not.toContain('MessageMetadata');
  });

  it('modify/src/db.ts adds getRecentMessages function', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/db.ts'),
      'utf-8',
    );
    expect(content).toContain('export function getRecentMessages');
  });

  it('modify/src/db.ts adds storeMessageDirect function', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/db.ts'),
      'utf-8',
    );
    expect(content).toContain('export function storeMessageDirect');
  });

  it('modify/src/db.ts preserves all base exports', () => {
    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify/src/db.ts'),
      'utf-8',
    );
    const baseExports = [
      'initDatabase', '_initTestDatabase', 'storeChatMetadata', 'updateChatName',
      'getAllChats', 'getLastGroupSync', 'setLastGroupSync', 'storeMessage',
      'getNewMessages', 'getMessagesSince', 'createTask', 'getTaskById',
      'getTasksForGroup', 'getAllTasks', 'updateTask', 'deleteTask',
      'getDueTasks', 'updateTaskAfterRun', 'logTaskRun', 'getRouterState',
      'setRouterState', 'getSession', 'setSession', 'getAllSessions',
      'getRegisteredGroup', 'setRegisteredGroup', 'getAllRegisteredGroups',
    ];
    for (const name of baseExports) {
      expect(content, `missing export: ${name}`).toContain(`export function ${name}`);
    }
  });

  // --- Intent files ---

  it('every modify file has a corresponding .intent.md', () => {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    const manifest = yamlParse(raw) as { modifies: string[] };
    for (const modPath of manifest.modifies) {
      const intentPath = path.join(SKILL_DIR, 'modify', `${modPath}.intent.md`);
      expect(fs.existsSync(intentPath), `intent file missing: ${modPath}.intent.md`).toBe(true);
    }
  });

  it('intent files document what changed and why', () => {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    const manifest = yamlParse(raw) as { modifies: string[] };
    for (const modPath of manifest.modifies) {
      const intentPath = path.join(SKILL_DIR, 'modify', `${modPath}.intent.md`);
      const content = fs.readFileSync(intentPath, 'utf-8');
      expect(content, `${modPath}.intent.md missing "What changed"`).toContain('What changed');
      expect(content, `${modPath}.intent.md missing "Why"`).toContain('Why');
      expect(content, `${modPath}.intent.md missing "Invariants"`).toContain('Invariants');
    }
  });

  // --- Structure ---

  it('has SKILL.md', () => {
    expect(fs.existsSync(path.join(SKILL_DIR, 'SKILL.md'))).toBe(true);
  });

  it('no extra files in add/ that are not in manifest', () => {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    const manifest = yamlParse(raw) as { adds: string[] };
    const declared = new Set(manifest.adds);

    function walkDir(dir: string, prefix = ''): string[] {
      const files: string[] = [];
      if (!fs.existsSync(dir)) return files;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          files.push(...walkDir(path.join(dir, entry.name), rel));
        } else {
          files.push(rel);
        }
      }
      return files;
    }

    const actual = walkDir(path.join(SKILL_DIR, 'add'));
    for (const file of actual) {
      expect(declared.has(file), `undeclared add file: ${file}`).toBe(true);
    }
  });
});
