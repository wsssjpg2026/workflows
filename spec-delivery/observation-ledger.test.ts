import test from 'node:test';
import assert from 'node:assert/strict';
import { associateObservations, completeObservationLedger, type RawObservation } from
  './review-skills/code-review-from-claude/observation-ledger.ts';

const raw:RawObservation[]=[
  {sourceKey:'lens-bugs',sourcePath:'/archive/bugs.json',description:'缓存删除后仍返回旧值',evidence:'cache.ts:42'},
  {sourceKey:'lens-git-history',sourcePath:'/archive/history.json',description:'Deleted cache key returns stale data',evidence:'cache.ts:42'},
  {sourceKey:'lens-guidelines',sourcePath:'/archive/guidelines.json',description:'日志泄露访问令牌',evidence:'logger.ts:18'},
  {sourceKey:'lens-code-comments',sourcePath:'/archive/comments.json',description:'Potential slow path',evidence:'cache.ts:61',
    preliminaryFilterReason:'Outside changed lines'},
];

test('默认技能包由专业判断显式关联中英文同一事实，一次确认保留全部来源和过滤理由',()=>{
  const indexed=associateObservations(raw,[]);
  assert.equal(indexed.observations.length,4);
  assert.equal(new Set(indexed.observations.map(x=>x.id)).size,4,'无稳定来源 ID 仍分配来源内序号');
  const [a,b,c,d]=indexed.observations.map(x=>x.id);
  const plan=associateObservations(raw,[
    {left:a,right:b,judgment:'same_fact',rationale:'同一 cache.ts:42 删除后的旧值行为',reviewer:'review-lead'},
    {left:a,right:c,judgment:'different_fact',rationale:'令牌泄露位于另一个文件',reviewer:'review-lead'},
    {left:b,right:d,judgment:'uncertain',rationale:'慢路径证据不能证明旧值缺陷',reviewer:'review-lead'},
  ]);
  assert.equal(plan.groups.length,3);
  const merged=plan.groups.find(x=>x.observationIds.length===2)!;
  assert.deepEqual(merged.sourceKeys,['lens-bugs','lens-git-history']);
  const confirmations=plan.groups.map((group,index)=>({groupId:group.id,childKey:`confirm-${index}`,
    score:group.id===merged.id?75:25,rationale:'Independent check against cited evidence',
    evidencePath:`/archive/confirm-${index}.json`}));
  const ledger=completeObservationLedger(plan,confirmations);
  assert.deepEqual(ledger.retainedGroupIds,[merged.id]);
  assert.equal(ledger.confirmations.length,3,'每个事实而非每条观察确认一次');
  assert.equal(ledger.filtered.length,2);
  assert.ok(ledger.filtered.some(x=>x.reason.includes('Outside changed lines')));
  assert.equal(ledger.observations.length,4,'过滤后仍保存原始观察');
  assert.throws(()=>completeObservationLedger(plan,confirmations.slice(1)),/恰好有一次/);
});

test('语义关系不确定或仅传递关联时保持不同事实分离',()=>{
  const [a,b,c]=associateObservations(raw.slice(0,3),[]).observations.map(x=>x.id);
  assert.throws(()=>associateObservations(raw.slice(0,3),[
    {left:a,right:b,judgment:'same_fact',rationale:'相同症状',reviewer:'review-lead'},
    {left:b,right:c,judgment:'same_fact',rationale:'声称相同',reviewer:'review-lead'},
    {left:a,right:c,judgment:'uncertain',rationale:'证据不一致',reviewer:'review-lead'},
  ]),/传递性误并/);
  const plan=associateObservations(raw.slice(0,3),[
    {left:a,right:b,judgment:'same_fact',rationale:'同一代码触发及后果',reviewer:'review-lead'},
    {left:a,right:c,judgment:'uncertain',rationale:'不同代码位置',reviewer:'review-lead'},
  ]);
  assert.equal(plan.groups.length,2);
});
