/** Historical protocol 2 review semantics. Public dispatch rejects that protocol. */
import type {Finding} from './core.ts';

export const historicalReviewLenses = ['规范', '明显缺陷', 'Git 历史', '历史 PR 评论', '代码注释'];
export const historicalBlocking = (finding:Finding) => (finding.confidence ?? 0) >= 50;
export function validateHistoricalConfirmation(finding:Finding) {
  if(!Number.isFinite(finding.confidence) || finding.confidence! < 0 || finding.confidence! > 100)
    throw new Error('缺少 0–100 置信评分');
  if(historicalBlocking(finding) && finding.confirmed !== true)
    throw new Error('>=50 的问题必须被独立证据确认');
}
