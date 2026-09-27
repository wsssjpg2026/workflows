/** Evidence bookkeeping for this review method. Semantic identity is a reviewer decision. */
import { createHash } from 'node:crypto';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,20);
function requireFact(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}

export interface RawObservation {
  sourceKey:string; sourcePath:string; sourceRecordId?:string; description:string; evidence:string;
  preliminaryFilterReason?:string;
}
export interface RecordedObservation extends RawObservation { id:string; ordinal:number }
export interface SemanticRelation {
  left:string; right:string; judgment:'same_fact'|'different_fact'|'uncertain';
  rationale:string; reviewer:string;
}
export interface ObservationGroup { id:string; observationIds:string[]; sourceKeys:string[]; sourcePaths:string[] }
export interface AssociationPlan {
  observations:RecordedObservation[]; relations:SemanticRelation[]; groups:ObservationGroup[];
}
export interface IndependentConfirmation {
  groupId:string; childKey:string; score:number; rationale:string; evidencePath:string;
  filterReason?:string;
}
export interface ObservationLedger extends AssociationPlan {
  schema:'code-review-from-claude-observations/v1';
  confirmations:IndependentConfirmation[];
  retainedGroupIds:string[]; filtered:{groupId:string;reason:string}[];
}

/** Record every raw view first. The caller supplies reasoned pair judgments before confirmation. */
export function associateObservations(raw:RawObservation[],relations:SemanticRelation[]):AssociationPlan {
  requireFact(Array.isArray(raw)&&Array.isArray(relations),'观察与语义判断必须是数组');
  const sourceOrdinals=new Map<string,number>();
  const observations=raw.map((observation,ordinal)=>{
    requireFact(observation.sourceKey?.trim()&&observation.sourcePath?.trim()&&
      observation.description?.trim()&&observation.evidence?.trim(),'原始观察缺少来源或事实');
    const sourceOrdinal=sourceOrdinals.get(observation.sourceKey)||0;
    sourceOrdinals.set(observation.sourceKey,sourceOrdinal+1);
    const localId=observation.sourceRecordId?.trim()||`ordinal:${sourceOrdinal}`;
    return {...observation,ordinal,id:`observation:${hash(JSON.stringify([observation.sourceKey,localId]))}`};
  });
  const ids=new Set(observations.map(x=>x.id));
  requireFact(ids.size===observations.length,'同一来源的观察 ID 重复');
  const judgments=new Map<string,SemanticRelation>();
  const pair=(a:string,b:string)=>[a,b].sort().join('\0');
  for(const relation of relations) {
    requireFact(ids.has(relation.left)&&ids.has(relation.right)&&relation.left!==relation.right&&
      ['same_fact','different_fact','uncertain'].includes(relation.judgment)&&
      relation.rationale?.trim()&&relation.reviewer?.trim(),'语义关联缺少独立判断、理由或有效观察 ID');
    const key=pair(relation.left,relation.right);
    requireFact(!judgments.has(key),'同一对观察有重复或冲突的语义判断');
    judgments.set(key,relation);
  }
  const parent=new Map(observations.map(x=>[x.id,x.id]));
  const root=(id:string):string=>{const p=parent.get(id)!;return p===id?id:root(p);};
  for(const relation of relations) if(relation.judgment==='same_fact')
    parent.set(root(relation.right),root(relation.left));
  const sets=new Map<string,RecordedObservation[]>();
  for(const observation of observations) {
    const key=root(observation.id),members=sets.get(key)||[];members.push(observation);sets.set(key,members);
  }
  const groups=[...sets.values()].map(members=>{
    const observationIds=members.map(x=>x.id).sort();
    for(let i=0;i<observationIds.length;i++)for(let j=i+1;j<observationIds.length;j++)
      requireFact(judgments.get(pair(observationIds[i],observationIds[j]))?.judgment==='same_fact',
        '无法确认全部观察属于同一事实；不允许传递性误并');
    return {id:`fact:${hash(JSON.stringify(observationIds))}`,observationIds,
      sourceKeys:[...new Set(members.map(x=>x.sourceKey))].sort(),
      sourcePaths:[...new Set(members.map(x=>x.sourcePath))].sort()};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  return {observations,relations,groups};
}

/** One independent confirmation per established fact; keep filtered observations and reasons. */
export function completeObservationLedger(plan:AssociationPlan,confirmations:IndependentConfirmation[]):ObservationLedger {
  requireFact(Array.isArray(confirmations)&&confirmations.length===plan.groups.length,
    '每个事实组必须恰好有一次独立确认');
  const byGroup=new Map(confirmations.map(x=>[x.groupId,x]));
  requireFact(byGroup.size===confirmations.length&&
    new Set(confirmations.map(x=>x.childKey)).size===confirmations.length,
    '独立确认不能重复事实组或复用子任务');
  const retainedGroupIds:string[]=[],filtered:{groupId:string;reason:string}[]=[];
  for(const group of plan.groups) {
    const confirmation=byGroup.get(group.id);
    requireFact(confirmation&&confirmation.childKey?.trim()&&confirmation.evidencePath?.trim()&&
      confirmation.rationale?.trim()&&Number.isFinite(confirmation.score)&&
      confirmation.score>=0&&confirmation.score<=100,'事实组缺少完整的独立确认');
    const preliminary=plan.observations.filter(x=>group.observationIds.includes(x.id))
      .map(x=>x.preliminaryFilterReason?.trim()).filter(Boolean);
    const reason=confirmation.filterReason?.trim() || (confirmation.score<50?`confidence ${confirmation.score} < 50`:undefined);
    if(reason)filtered.push({groupId:group.id,reason:[...preliminary,reason].join('; ')});
    else retainedGroupIds.push(group.id);
  }
  return {schema:'code-review-from-claude-observations/v1',...plan,confirmations,retainedGroupIds,filtered};
}
