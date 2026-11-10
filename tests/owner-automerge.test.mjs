import test from "node:test";
import assert from "node:assert/strict";
import { mayEnableAutoMerge } from "../scripts/owner-automerge.mjs";

const ownerPR=()=>({
    action:"opened",
    sender:{login:"Tigon32"},
    repository:{full_name:"Tigon32/miniquad"},
    pull_request:{
        number:101,
        state:"open",
        draft:false,
        user:{login:"Tigon32"},
        author_association:"OWNER",
        head:{sha:"a".repeat(40),repo:{full_name:"Tigon32/miniquad"}},
        base:{ref:"master",repo:{full_name:"Tigon32/miniquad"}}
    }
});

test("allows only a non-draft PR from the repository owner",()=>{
    assert.equal(mayEnableAutoMerge(ownerPR()),true);
});
test("refuses an external PR author",()=>{
    const x=ownerPR();x.pull_request.user.login="external";
    assert.equal(mayEnableAutoMerge(x),false);
});
test("refuses a fork even when the author name matches",()=>{
    const x=ownerPR();x.pull_request.head.repo.full_name="external/miniquad";
    assert.equal(mayEnableAutoMerge(x),false);
});
test("refuses changes sent by an actor other than the owner",()=>{
    const x=ownerPR();x.sender.login="github-actions[bot]";
    assert.equal(mayEnableAutoMerge(x),false);
});
test("refuses draft and closed pull requests",()=>{
    const draft=ownerPR();draft.pull_request.draft=true;
    const closed=ownerPR();closed.pull_request.state="closed";
    assert.equal(mayEnableAutoMerge(draft),false);
    assert.equal(mayEnableAutoMerge(closed),false);
});
test("refuses the wrong base branch or repository",()=>{
    const wrongBranch=ownerPR();wrongBranch.pull_request.base.ref="development";
    const wrongRepo=ownerPR();wrongRepo.repository.full_name="external/miniquad";
    assert.equal(mayEnableAutoMerge(wrongBranch),false);
    assert.equal(mayEnableAutoMerge(wrongRepo),false);
});
test("refuses PRs whose author is not marked as repository owner",()=>{
    const x=ownerPR();x.pull_request.author_association="CONTRIBUTOR";
    assert.equal(mayEnableAutoMerge(x),false);
});
test("refuses malformed commits and issue numbers",()=>{
    const x=ownerPR();x.pull_request.head.sha="not-a-commit";
    const y=ownerPR();y.pull_request.number=0;
    assert.equal(mayEnableAutoMerge(x),false);
    assert.equal(mayEnableAutoMerge(y),false);
});
test("refuses unrelated events and missing fields",()=>{
    const x=ownerPR();x.action="closed";
    assert.equal(mayEnableAutoMerge(x),false);
    assert.equal(mayEnableAutoMerge(null),false);
    assert.equal(mayEnableAutoMerge({action:"opened"}),false);
});
