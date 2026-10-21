import assert from 'node:assert/strict';
import test from 'node:test';
import { enumKeys, isQuery, sanitize } from '../record-gh-shapes.mjs';
import { loadShapes, unknownFields } from './gh-shapes.mjs';

// The fake gh checks every query of the board tests with unknownFields (fake-gh.mjs); these cases are the check itself and the recordings.

test('a query that asks for a field GitHub did not answer is found, with its path', () => {
  assert.deepEqual(unknownFields('query($o:String!){viewer{login} repository(owner:$o){issue(number:1){id nonsense labels(first:2){nodes{name oops}}}}}'),
    ['repository.issue.nonsense', 'repository.issue.labels.nodes.oops']);
  assert.deepEqual(unknownFields('query{viewer{login}}'), []);
});

test('fields of a fragment and an alias are checked under their response name', () => {
  assert.deepEqual(unknownFields('query{nodes(ids:["a"]){...on Issue{id} ...on PullRequest{nonsense}}}'), ['nodes.nonsense']);
  assert.deepEqual(unknownFields('query($o:String!){repository(owner:$o){issue(number:1){projectItems(first:1){nodes{status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}'), []);
});

test('the recordings hold no names or texts', () => {
  const strings = [];
  JSON.stringify(loadShapes(), (key, value) => { if (typeof value === 'string' && !enumKeys.has(key)) strings.push(value); return value; });
  assert.ok(strings.length);
  assert.deepEqual(strings.filter(text => text !== 'x'), []);
});

test('recording sends queries only and keeps no text', () => {
  assert.equal(isQuery('mutation($i:ID!){closeIssue(input:{issueId:$i}){clientMutationId}}'), false);
  assert.deepEqual(sanitize({ title: 'Secret', state: 'OPEN', n: 42, list: [{ a: 'x', b: null }, { b: { c: true } }] }),
    { title: 'x', state: 'OPEN', n: 1, list: [{ a: 'x', b: { c: true } }] });
});
