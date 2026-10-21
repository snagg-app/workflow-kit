// `block` and `sub`: native blocker and sub-issue links.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';

/** What `board.mjs help` and the parser know about the command; `run` names the function this module returns. */
export const specs = [
  { name: 'block', run: 'block', writes: true, doc: 'docs/board/block.md', words: [{ name: 'ISSUE', kind: 'number' }, { name: 'BLOCKER', kind: 'reference' }],
    summary: 'Marks ISSUE as blocked by BLOCKER (N, #N or OWNER/REPO#N).' },
  { name: 'sub', run: 'sub', writes: true, doc: 'docs/board/block.md', words: [{ name: 'PARENT', kind: 'number' }, { name: 'CHILD', kind: 'reference' }],
    summary: 'Makes CHILD (N, #N or OWNER/REPO#N) a native sub-issue of PARENT, read back. An existing link succeeds again.' },
];

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createBlock(env) {
  const { blockerRepository, graphql, named, number, project, readIssue, state } = env;

  function block() {
    const [blockerOwner, blockerName] = blockerRepository(state.value).split('/');
    const blockerNumber = state.value.slice(state.value.lastIndexOf('#') + 1);
    const { id } = named(`${blockerOwner}/${blockerName}#${blockerNumber}`, () => graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}`,
      { owner: blockerOwner, name: blockerName, number: Number(blockerNumber) }).repository.issue ?? assert.fail('issue not found'));
    graphql(`mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{number}}}`,
      { issue: readIssue().id, blocker: id });
    console.log(`${project.repository}#${number} is blocked by ${blockerOwner}/${blockerName}#${blockerNumber}`);
  }

  // Attaches CHILD as a native sub-issue of ISSUE and reads the parent link back; an existing link is a success.
  function sub() {
    const [childOwner, childName] = blockerRepository(state.value).split('/');
    const childNumber = Number(state.value.slice(state.value.lastIndexOf('#') + 1));
    const read = () => named(`${childOwner}/${childName}#${childNumber}`, () => graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id parent{number repository{nameWithOwner}}}}}`,
      { owner: childOwner, name: childName, number: childNumber }).repository.issue ?? assert.fail('issue not found'));
    const underParent = ({ parent }) => parent?.number === number && parent.repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase();
    const child = read();
    // Without replaceParent GitHub refuses a child that already has another parent; that error is left to surface.
    if (!underParent(child)) graphql(`mutation($issue:ID!,$sub:ID!){addSubIssue(input:{issueId:$issue,subIssueId:$sub}){issue{number}}}`,
      { issue: readIssue().id, sub: child.id });
    assert.ok(underParent(read()), `#${number} did not take ${state.value} as sub-issue (read-back shows another parent)`);
    console.log(`${project.repository}#${number} has sub-issue ${childOwner}/${childName}#${childNumber}`);
  }

  return { block, sub };
}
