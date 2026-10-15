import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMatchPrivacy, privacyRecord } from '../shared/matchPrivacy.js';
import { recentParticipatedGames, recentCoPlayers, canViewProfile } from '../shared/social.js';
import { SocialService } from '../server/social/service.js';

const flags = ['matchPrivacy', 'isMatchingMatch', 'matching'].flatMap(key => [
  { label: key, value: { [key]: true } },
  { label: `result.${key}`, value: { result: { [key]: true } } },
]);
const participants = [{ name: '本人', doctorCode: '0001' }, { name: '队友', doctorCode: '0002' }];
for (const { label, value } of flags) {
  test(`legacy privacy ${label} excludes recent teammates before the five-game limit and cannot grant profile access`, () => {
    const hidden = { id: 'private', ended: true, participants, ...value };
    const publicGames = Array.from({ length: 5 }, (_, i) => ({ id: `public-${i}`, ended: true, participants: [participants[0]], endedAt: i }));
    for (const field of ['socialRecentMatches', 'history']) {
      const profile = { name: '本人', code: '0001', [field]: [...Array(6).fill(hidden), ...publicGames] };
      assert.deepEqual(recentParticipatedGames(profile).map(g => g.id), publicGames.map(g => g.id));
      assert.deepEqual(recentCoPlayers(profile), []);
      assert.equal(canViewProfile('队友#0002', profile), false);
      assert.equal(canViewProfile('队友#0002', { ...profile, friends: ['队友#0002'] }), true);
    }
    assert.equal(hasMatchPrivacy(hidden), true);
    assert.equal(privacyRecord(hidden).participants[1].doctorCode, undefined);
    assert.equal(hidden.participants[1].doctorCode, '0002', 'durable identity must not be mutated');
  });
  test(`legacy privacy ${label} blocks archive migration and settlement caching`, () => {
    for (const flaggedRecord of [false, true]) {
      const profile = { name: '本人', code: '0001', statistics: { records: [{ id: 'private', ...(flaggedRecord ? value : {}) }, { id: 'public' }] } };
      const archives = { private: { participants, result: {}, ...(!flaggedRecord ? value : {}) }, public: { participants, result: {}, endedAt: 1 } };
      const saved = [];
      const lobby = { accountStats: { allProfiles: () => [profile], rawArchive: id => archives[id] }, profiles: { save: p => saved.push(p) } };
      const service = new SocialService(lobby);
      assert.deepEqual(profile.socialRecentMatches.map(g => g.id), ['public']);
      assert.equal(saved.length, 1);
      for (const where of ['context', 'summary', 'match']) {
        const context = { profiles: [], ...(where === 'context' ? value : {}), ...(where === 'match' ? { match: value } : {}) };
        // No read/clock/changed methods exist: a private settlement must return before any mutation.
        service.remember(context, where === 'summary' ? value : {});
      }
    }
  });
}
test('unmarked normal games retain recent-teammate access and already migrated profiles are not rescanned', () => {
  const profile = { name: '本人', code: '0001', socialVersion: 1, socialRecentMatches: [{ id: 'normal', participants }] };
  assert.equal(canViewProfile('队友#0002', profile), true);
  assert.equal(hasMatchPrivacy({ result: {} }), false);
  new SocialService({ accountStats: { allProfiles: () => [profile], rawArchive: () => assert.fail('must not rescan migrated archives') } });
});
