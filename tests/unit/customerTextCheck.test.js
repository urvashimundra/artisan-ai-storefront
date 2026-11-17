import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mentionsInternals } from '../../src/ai/customerTextCheck.js';

describe('mentionsInternals: replies must not describe how they were produced', () => {
  it('flags placeholder, template, tool and live-filling wording in English', () => {
    for (const text of [
      'Prices shown as placeholders filled in live.',
      'The price is in the template.',
      'I used the calculate_quote tool for this.',
      'The tool results say 10 left.',
      'Filled live from the database.',
    ]) assert.equal(mentionsInternals(text), true, text);
  });

  it('flags the same wording in Gujarati and Hindi', () => {
    for (const text of ['પ્લેસહોલ્ડર ભરીને બતાવ્યું છે.', 'ટેમ્પલેટ પ્રમાણે કિંમત.', 'टेम्पलेट से जानकारी दी है।', 'प्लेसहोल्डर में कीमत है।', 'लाइव में भरे गए दाम।']) {
      assert.equal(mentionsInternals(text), true, text);
    }
  });

  it('does not flag ordinary answers', () => {
    for (const text of ['We ship in five days.', 'અમે પાંચ દિવસમાં મોકલીએ છીએ.', 'हम पाँच दिन में भेजते हैं।']) {
      assert.equal(mentionsInternals(text), false, text);
    }
  });

  it('ignores the shop’s own product names, which may contain these words', () => {
    assert.equal(mentionsInternals('Our Tool Kit ships in five days.', ['Tool Kit']), false);
    assert.equal(mentionsInternals('Our Tool Kit ships in five days.'), true);
  });
});
