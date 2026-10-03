const crypto = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { buildIosOwnershipId } = require('./subscriptionOwnership');
const PRODUCT = 'ohayo_kamome_monthly';
function identity(data) {
  const productId = String(data?.productId || '');
  const transactionId = String(data?.transactionId || '');
  if (productId !== PRODUCT || !/^\d{5,}$/.test(transactionId)) {
    throw new HttpsError('invalid-argument', 'Invalid completion transaction.');
  }
  return { productId, transactionId, transactionHash: crypto.createHash('sha256').update(`ios:${productId}:${transactionId}`).digest('hex') };
}
function recordRef(db, hash) {
  return db.collection('subscription_ownership').doc('ios_completion').collection('transactions').doc(hash);
}
async function readCompletion(db, uid, data, tx = null) {
  const id = identity(data);
  const read = ref => tx ? tx.get(ref) : ref.get();
  const snap = await read(recordRef(db, id.transactionHash));
  if (!snap.exists) return { state: 'absent', ...id };
  const r = snap.data() || {};
  // A foreign verified record is never an absent record and cannot authorize
  // verification/reassignment under the currently signed-in user.
  if (r.ownerUid && r.ownerUid !== uid) {
    throw new HttpsError('failed-precondition', 'Transaction belongs to another user.', { code: 'SUBSCRIPTION_ALREADY_LINKED' });
  }
  if (r.schema !== 1 || r.ownerUid !== uid || r.verified !== true || r.transactionHash !== id.transactionHash || r.productId !== id.productId ||
      typeof r.ownershipId !== 'string' || !/^ios_\d{5,}$/.test(r.ownershipId) || !['pending', 'completed'].includes(r.completionState) || !['active', 'expired', 'inactive'].includes(r.subscriptionStatus)) return { state: 'inconsistent', ...id };
  const owner = await read(db.collection('subscription_ownership').doc(r.ownershipId));
  if (!owner.exists || owner.get('ownerUid') !== uid) {
    if (owner.exists && owner.get('ownerUid') && owner.get('ownerUid') !== uid) {
      throw new HttpsError('failed-precondition', 'Purchase series belongs to another user.', { code: 'SUBSCRIPTION_ALREADY_LINKED' });
    }
    return { state: 'inconsistent', ...id };
  }
  return { state: 'verified', verified: true, ownerMatches: true, productId: r.productId,
    transactionHash: id.transactionHash, completed: r.completionState === 'completed', subscriptionStatus: r.subscriptionStatus };
}
function completionWrite(db, admin, uid, transactionInfo, status) {
  const id = identity({ productId: transactionInfo.productId, transactionId: transactionInfo.transactionId });
  return { ref: recordRef(db, id.transactionHash), data: { schema: 1, transactionHash: id.transactionHash,
    productId: id.productId, ownerUid: uid, verified: true, subscriptionStatus: status,
    ownershipId: buildIosOwnershipId(transactionInfo.originalTransactionId || transactionInfo.transactionId),
    completionState: 'pending', verifiedAt: admin.FieldValue.serverTimestamp() } };
}
function createCompletionHandler(admin, operation) {
  return async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
    const uid = request.auth.uid;
    if (operation === 'read') return readCompletion(admin.getDb(), uid, request.data);
    return admin.getDb().runTransaction(async tx => {
      const r = await readCompletion(admin.getDb(), uid, request.data, tx);
      if (r.state !== 'verified') throw new HttpsError('failed-precondition', 'Verified transaction required.');
      if (!r.completed) tx.set(recordRef(admin.getDb(), r.transactionHash), {
        completionState: 'completed', completedAt: admin.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { ...r, completed: true };
    });
  };
}
module.exports = { readCompletion, completionWrite, createCompletionHandler };
