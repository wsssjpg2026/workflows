#!/usr/bin/env node
/** A file-backed GitHub contract fixture for the single-ledger v0.3 replay. */
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const file = process.env.SPEC_DELIVERY_COMBINED_REMOTE;
if (!file) throw Error('missing combined remote fixture');
const argv = process.argv.slice(2);
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(db));
const endpoint = argv.at(-1) || '';
const issue = number => ({number, title:number===100?'Spec':'Task '+number,
  body:'Observable delivery criterion for '+number,
  html_url:'https://github.com/example/test/issues/'+number,
  state:(db.issues[number] || 'OPEN').toLowerCase(), assignees:[]});
const pr = row => ({number:row.number,html_url:'https://github.com/example/test/pull/'+row.number,
  head:{sha:row.head,ref:row.headRef},base:{sha:row.base,ref:'main'},
  state:row.state==='MERGED'?'closed':'open',merged:row.state==='MERGED',
  merge_commit_sha:row.state==='MERGED'?row.mergedHead:null,
  draft:false,mergeable:true,body:row.body});
const pages = rows => console.log(JSON.stringify([rows]));
const json = value => console.log(JSON.stringify(value));
const numberFrom = pattern => Number(endpoint.match(pattern)?.[1] || 0);

if (argv[0]==='repo' && argv[1]==='view') {
  json({nameWithOwner:'example/test',url:'https://github.com/example/test',
    defaultBranchRef:{name:'main'}});
} else if (argv.includes('graphql')) {
  const query = argv.find(value => value.startsWith('query=')) || '';
  const repository = {target:{target:{oid:db.base}}};
  for (const match of query.matchAll(/i(\d+):issue/g)) {
    const number=Number(match[1]);
    repository['i'+number]={number,state:db.issues[number] || 'OPEN'};
  }
  for (const match of query.matchAll(/p(\d+):pullRequest/g)) {
    const number=Number(match[1]),row=db.prs[number];
    if (!row) throw Error('unknown PR '+number);
    repository['p'+number]={number,url:'https://github.com/example/test/pull/'+number,
      state:row.state,headRefOid:row.head,baseRefOid:row.base,
      baseRefName:'main',headRefName:row.headRef,isDraft:false,
      mergeable:'MERGEABLE',mergeCommit:row.state==='MERGED'?{oid:row.mergedHead}:null};
  }
  json({data:{repository}});
} else if (argv[0]==='pr' && argv[1]==='merge') {
  const number=Number(argv[2]),row=db.prs[number];
  if (!row || row.head!==argv[argv.indexOf('--match-head-commit')+1]) throw Error('stale PR merge');
  row.state='MERGED';row.mergedHead=row.head;db.base=row.mergedHead;save();
  execFileSync('git',['-C',db.repo,'push',db.bare,row.mergedHead+':refs/heads/main'],
    {stdio:['ignore','pipe','pipe']});
  execFileSync('git',['-C',db.repo,'push',db.bare,':refs/heads/'+row.headRef],
    {stdio:['ignore','pipe','pipe']});
  console.log('merged');
} else if (argv[0]==='pr' && argv[1]==='comment') {
  const number=Number(argv[2]);
  const body=fs.readFileSync(argv[argv.indexOf('--body-file')+1],'utf8');
  const rows=db.comments[number] ||= [];
  const result={html_url:'https://github.com/example/test/issues/'+number+'#issuecomment-'+(rows.length+1),body};
  rows.push(result);save();console.log(result.html_url);
} else if (argv[0]==='issue' && argv[1]==='close') {
  const number=Number(argv[2]);db.issues[number]='CLOSED';save();console.log('closed');
} else if (argv[0]==='issue' && argv[1]==='comment') {
  const number=Number(argv[2]);
  const body=fs.readFileSync(argv[argv.indexOf('--body-file')+1],'utf8');
  const rows=db.comments[number] ||= [];
  const result={html_url:'https://github.com/example/test/issues/'+number+'#issuecomment-'+(rows.length+1),body};
  rows.push(result);save();console.log(result.html_url);
} else if (argv.includes('--method') && argv.includes('POST') && endpoint.endsWith('/pulls')) {
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  const number=db.nextPr++;
  const head=execFileSync('git',['-C',db.repo,'rev-parse',input.head],{encoding:'utf8'}).trim();
  if (!head) throw Error('unknown PR branch '+input.head);
  db.prs[number]={number,head,base:db.base,headRef:input.head,state:'OPEN',body:input.body};
  if(db.loseCreateResponse){db.loseCreateResponse=false;db.lostCreateResponses++;save();process.exit(1);}
  save();json({number});
} else if (argv.includes('--method') && argv.includes('POST') && /\/issues\/\d+\/comments$/.test(endpoint)) {
  const number=numberFrom(/\/issues\/(\d+)\/comments$/);
  const body=JSON.parse(fs.readFileSync(0,'utf8')).body;
  const rows=db.comments[number] ||= [];
  const result={html_url:'https://github.com/example/test/issues/'+number+'#issuecomment-'+(rows.length+1),body};
  rows.push(result);
  if(db.loseCommentResponse){db.loseCommentResponse=false;db.lostCommentResponses++;save();process.exit(1);}
  save();json(result);
} else if (endpoint.endsWith('/git/ref/heads/main')) {
  json({ref:'refs/heads/main',object:{type:'commit',sha:db.base}});
} else if (/\/issues\/\d+\/sub_issues\?/.test(endpoint)) {
  pages(numberFrom(/\/issues\/(\d+)\/sub_issues\?/ )===100?[issue(101),issue(102),issue(103)]:[]);
} else if (/\/issues\/\d+\/dependencies\/blocked_by\?/.test(endpoint)) {
  pages(numberFrom(/\/issues\/(\d+)\/dependencies\/blocked_by\?/)===103?[issue(101),issue(102)]:[]);
} else if (/\/issues\/\d+\/comments\?/.test(endpoint)) {
  pages(db.comments[numberFrom(/\/issues\/(\d+)\/comments\?/)] || []);
} else if (/\/issues\/\d+$/.test(endpoint)) {
  json(issue(numberFrom(/\/issues\/(\d+)$/)));
} else if (/\/pulls\?/.test(endpoint)) {
  const query=new URLSearchParams(endpoint.split('?')[1]);
  const head=(query.get('head') || '').split(':').at(-1);
  pages(Object.values(db.prs).filter(row=>row.headRef===head).map(pr));
} else if (/\/pulls\/\d+$/.test(endpoint)) {
  const row=db.prs[numberFrom(/\/pulls\/(\d+)$/)];
  if (!row) throw Error('unknown PR');
  json(pr(row));
} else if (/\/commits\/[a-f0-9]+\/check-suites\?/.test(endpoint)) {
  json([{total_count:0,check_suites:[]}]);
} else if (/\/commits\/[a-f0-9]+\/check-runs\?/.test(endpoint)) {
  json([{total_count:0,check_runs:[]}]);
} else if (/\/commits\/[a-f0-9]+\/status\?/.test(endpoint)) {
  const head=endpoint.match(/\/commits\/([a-f0-9]+)\/status\?/)?.[1];
  const status=db.checkByHead[head];
  const statuses=status?[{id:7001,context:'fixture/required',state:status==='pass'?'success':status==='failed'?'failure':'pending',
    url:'https://github.com/example/test/status/7001',target_url:null}]:[];
  json([{total_count:statuses.length,statuses}]);
} else if (/\/commits\/[a-f0-9]+\/check/.test(endpoint)) {
  throw Error('unhandled check fixture');
} else if (/\/git\/commits\/[a-f0-9]+$/.test(endpoint)) {
  const head=endpoint.match(/\/git\/commits\/([a-f0-9]+)$/)?.[1];
  json({tree:{sha:db.trees[head] || head}});
} else if (/\/actions\/runs\?/.test(endpoint)) {
  json([{total_count:0,workflow_runs:[]}]);
} else if (/\/actions\/workflows\?/.test(endpoint)) {
  json([{total_count:0,workflows:[]}]);
} else if (/\/protection\/required_status_checks$/.test(endpoint)) {
  json({contexts:[],checks:[]});
} else {
  throw Error('unexpected combined GitHub fixture call: '+argv.join(' '));
}
