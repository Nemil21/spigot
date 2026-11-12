import { FakePayPalExtras } from './fake/extras.js';
import { FAKE_WEBHOOK_ID } from './fake/webhooks.js';
import { moneyOut } from './moneyOut.js';
import { describeMoneyOutContract } from './moneyOutContract.js';

describeMoneyOutContract('FakePayPal', async () => {
  const fake = new FakePayPalExtras();
  let seq = 0;
  return {
    pp: moneyOut(fake.transport(), FAKE_WEBHOOK_ID),
    async makeCapture(amountCents) {
      const id = `CAPTURE${++seq}`;
      fake.refunds.addCapture(id, amountCents);
      return id;
    },
    payoutEmail: 'publisher@example.com',
  };
});
