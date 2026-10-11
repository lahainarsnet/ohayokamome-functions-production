FROM node:20-bookworm-slim
WORKDIR /app/functions
COPY functions/package.json functions/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY functions/googlePlaySubscriptionNotifications.js functions/subscriptionEntitlement.js functions/subscriptionOwnership.js functions/preChatBillingConfirmation.js functions/appStoreServerCommon.js functions/accountAccessUsability.js functions/firebaseAdmin.js ./
COPY functions/dailyReport/increment.js functions/dailyReport/jstDate.js functions/dailyReport/schema.js ./dailyReport/
COPY functions/jobs/billingDryRun/config.js functions/jobs/billingDryRun/core.js functions/jobs/billingDryRun/entry.js ./jobs/billingDryRun/
ENTRYPOINT ["node", "jobs/billingDryRun/entry.js"]
