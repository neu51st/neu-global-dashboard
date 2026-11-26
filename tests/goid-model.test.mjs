import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../goid-model.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source + '\nglobalThis.__goid = { rank, match, published, CAMPUSES };', context);
const { rank, match, published, CAMPUSES } = context.__goid;

const preferences = {
  users: ['Student'],
  categories: ['Academic Internationalization'],
  types: ['Scholarships'],
  countries: ['Philippines'],
  funding_coverage: ['Fully Funded'],
  expenses: ['Travel'],
  benefits: ['Skills Development'],
  formats: ['Online'],
  documents: ['Academic Records'],
  methods: ['Direct Application'],
  timeline: 'Within 3 Months'
};

const baseOpportunity = {
  verification: 'VERIFIED',
  archived: false,
  is_demo: false,
  sector: 'Academic Internationalization',
  country: 'Philippines',
  deadline: null,
  application_status: 'OPEN',
  match_data: {
    intended_users: ['Student'],
    types: ['Scholarships'],
    funding_coverage: 'Fully Funded',
    expenses: ['Travel'],
    benefits: ['Skills Development'],
    formats: ['Online'],
    documents: ['Academic Records'],
    methods: ['Direct Application'],
    deadline_kind: 'No Fixed Deadline'
  }
};

test('student recommendations are limited to the top 10 verified, active, non-demo records', () => {
  const records = Array.from({ length: 14 }, (_, i) => ({
    ...baseOpportunity, id: String(i), title: 'Opportunity ' + i
  }));
  records.push({ ...baseOpportunity, id: 'demo', is_demo: true, title: 'Demo' });
  records.push({ ...baseOpportunity, id: 'archived', archived: true, title: 'Archived' });
  records.push({ ...baseOpportunity, id: 'pending', verification: 'PENDING VERIFICATION', title: 'Pending' });
  records.push({ ...baseOpportunity, id: 'closed', deadline: '2000-01-01', title: 'Closed' });

  const result = Array.from(rank(records, preferences));
  assert.equal(result.length, 10);
  assert.ok(result.every(item => item.verification === 'VERIFIED' && !item.archived && !item.is_demo));
  assert.ok(!result.some(item => ['demo', 'archived', 'pending', 'closed'].includes(item.id)));
});

test('preference match is separate from evidence scoring and confidence ratings', () => {
  const result = match(baseOpportunity, preferences);
  assert.equal(result.score, 100);
  assert.ok(Array.isArray(result.matched));
  assert.equal('confidence' in result, false);
  assert.equal('assessment' in result, false);
});

test('campus directory follows the published campus-specific college offerings', () => {
  assert.ok(Array.from(CAMPUSES['Quezon City — Main Campus']).includes('College of Nursing'));
  assert.deepEqual(
    Array.from(CAMPUSES['General Santos City Campus']),
    ['College of Accountancy', 'College of Business Administration', 'Other / Not Applicable']
  );
  assert.deepEqual(
    Array.from(CAMPUSES['Rizal Campus']),
    ['College of Agriculture', 'Other / Not Applicable']
  );
});
