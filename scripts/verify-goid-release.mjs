import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [index, app, model, css, config, migration, dryRun] = await Promise.all([
  read('index.html'), read('goid-app.js'), read('goid-model.js'),
  read('goid.css'), read('config.js'),
  read('supabase/GOID_V2_ADDITIVE_MIGRATION.sql'),
  read('supabase/GOID_V2_DRY_RUN.sql')
]);

assert.ok(index.includes('goid-model.js?v=20261127'));
assert.ok(index.includes('goid-app.js?v=20261127'));
assert.ok(index.includes('assets/neu-logo.png'));
assert.ok(app.includes('assets/neu-wordmark.png'));

for (const asset of [
  'assets/neu-logo.png',
  'assets/neu-wordmark.png',
  'assets/neu-main-campus.jpg',
  'assets/campus-outline-login.svg'
]) await access(new URL('../' + asset, import.meta.url));

assert.ok(css.includes('assets/neu-main-campus.jpg'));
assert.ok(css.includes('opacity:.12'));
assert.ok(css.includes('linear-gradient(180deg'));
assert.ok(css.includes('assets/campus-outline-login.svg'));

for (const feature of [
  'For You · Top 10',
  'slice(0,3)',
  'Archived',
  'Restore',
  'Delete',
  'goid_notifications',
  'goid-profile-photos',
  'select(\'campus\',\'Campus\'',
  'select(\'college\',\'College / Department\''
]) assert.ok(app.includes(feature), 'Missing V2 feature: ' + feature);

for (const legacy of [
  'NEU_CRITERIA', 'NEU_RUBRIC', 'neuScore', 'scoreRanked',
  'Evidence-based assessment', 'Scoring Settings',
  'o.score', 'o.priority', 'o.decision', 'PURSUE',
  'MONITOR', 'INVESTIGATE FURTHER', 'NOT ASSESSED',
  'datalistField', 'Top 20'
]) assert.equal(app.includes(legacy), false, 'Legacy UI still present: ' + legacy);

assert.ok(model.includes('!o.is_demo'));
assert.ok(model.includes('College of Engineering & Architecture'));
assert.ok(model.includes('General Santos City Campus'));

assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS public.goid_notifications'));
assert.ok(migration.includes('goid_valid_college'));
assert.ok(migration.includes('goid_archive_opportunity'));
assert.ok(migration.includes('goid_analytics'));
assert.ok(migration.trimEnd().endsWith('COMMIT;'));
assert.equal(/DROP\s+TABLE/i.test(migration), false);
assert.equal(/DROP\s+COLUMN/i.test(migration), false);
assert.equal(/^\s*TRUNCATE\b/im.test(migration), false);
assert.equal(/UPDATE public\.opportunities SET evidence=/i.test(migration), false);
assert.equal(/match_data=p->'match_data',evidence=/i.test(migration), false);
assert.ok(dryRun.includes('ROLLBACK;'));

assert.equal(/service[_-]?role/i.test(config), false);
assert.equal(/smtp[_-]?password/i.test(config), false);

console.log('GOID V2 release checks passed.');
