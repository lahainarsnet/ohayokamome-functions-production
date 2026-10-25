# retired_tests
`expiredOwnershipServerDerived.test.js` asserts the Build 477 "latest holder wins" claim rule (a different Firebase UID
takes over a series through `claimOwnershipDocument`). The production purchase-verification path (Build 478) rejects
other-UID series instead, and transferActiveContractOwnership is the only path that moves a contract between UIDs.
The file was not part of `npm test`. It is kept here unchanged (no longer in the deploy-time test list) for history.
