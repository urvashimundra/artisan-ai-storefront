import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collapseRepeatedWords, withEstimateLine, withoutEstimateSentences } from '../../src/ai/replyPolish.js';
import { hasUnverifiedNumber } from '../../src/ai/moneyPlaceholders.js';
import { CONVERSATION_STRINGS } from '../../src/domain/conversationStrings.js';
import { buildMessageView } from '../../src/services/conversationView.js';
import { stringsFor } from '../../src/domain/publicStrings.js';

describe('withoutEstimateSentences', () => {
  it('removes estimate / seller-will-confirm sentences in all three languages, however they are worded', () => {
    assert.equal(withoutEstimateSentences('Total ₹100. This is an estimate. The seller will confirm.', 'en'), 'Total ₹100.');
    assert.equal(withoutEstimateSentences('કુલ ₹100 છે. આ અંદાજ છે, અંતિમ પુષ્ટિ વિક્રેતા કરશે.', 'gu'), 'કુલ ₹100 છે.');
    assert.equal(withoutEstimateSentences('કુલ ₹100 છે. આ અંદાજ છે. વિક્રેતા પુષ્ટિ કરશે.', 'gu'), 'કુલ ₹100 છે.');
    assert.equal(withoutEstimateSentences('कुल ₹100 है। यह अनुमान है, विक्रेता पुष्टि करेंगे।', 'hi'), 'कुल ₹100 है।');
  });
  it('never removes a sentence with money, digits or other content', () => {
    for (const [text, language] of [
      ['The estimate is ₹100 for 10 lamps.', 'en'], ['The seller will confirm delivery dates.', 'en'], ['Delivery estimate: ships soon after the festival season ends and the workshop reopens.', 'en'],
      ['અંદાજ ₹100 છે.', 'gu'], ['વિક્રેતા ડિલિવરીની તારીખ આજે સાંજે પુષ્ટિ કરશે.', 'gu'], ['अनुमान ₹100 है।', 'hi'],
    ]) assert.equal(withoutEstimateSentences(text, language), text);
  });
  it('keeps delivery, timeline and availability sentences that merely mention an estimate, and unrelated seller confirmations', () => {
    for (const [text, language] of [
      ["The delivery estimate is based on the seller's current schedule.", 'en'], ['Production usually takes about a week, which is only an estimate.', 'en'],
      ['The seller will confirm delivery dates.', 'en'], ['This lamp is handmade from local clay and is a good gift.', 'en'],
      ['ડિલિવરીનો અંદાજ વિક્રેતાના હાલના સમયપત્રક પર આધારિત છે.', 'gu'], ['ઉત્પાદનનો સમય માત્ર અંદાજ છે.', 'gu'], ['વિક્રેતા ડિલિવરીની તારીખ પુષ્ટિ કરશે.', 'gu'],
      ['डिलीवरी का अनुमान विक्रेता के मौजूदा शेड्यूल पर आधारित है।', 'hi'], ['तैयार होने का समय केवल अनुमान है।', 'hi'], ['विक्रेता डिलीवरी की तारीख की पुष्टि करेंगे।', 'hi'],
    ]) assert.equal(withoutEstimateSentences(text, language), text);
  });
  it('removes only the disclaimer sentence when useful sentences surround it', () => {
    assert.equal(withoutEstimateSentences('The delivery estimate is two weeks. This is an estimate. The seller will confirm.', 'en'), 'The delivery estimate is two weeks.');
  });
  it('conservatively keeps estimate sentences that mention a timeline word', () => {
    const generic = 'The total is an estimate for delivery.';
    const useful = 'The delivery estimate is two weeks.';
    assert.equal(withoutEstimateSentences(generic, 'en'), generic);
    assert.equal(withoutEstimateSentences(useful, 'en'), useful);
  });
  it('returns an empty string when the whole reply is only estimate wording, so the server line is the only one', () => {
    for (const language of ['en', 'gu', 'hi']) {
      const note = stringsFor(language).quoteEstimateNote;
      assert.equal(withoutEstimateSentences(note, language), '');
      assert.equal(withEstimateLine(withoutEstimateSentences(note, language), note), note);
    }
    assert.equal(withEstimateLine(withoutEstimateSentences('This is an estimate.', 'en'), 'This is an estimate. The seller will confirm.'), 'This is an estimate. The seller will confirm.');
  });
});

describe('collapseRepeatedWords', () => {
  it('collapses adjacent repeats in Latin, Gujarati and Hindi, ignoring case and light punctuation', () => {
    assert.equal(collapseRepeatedWords('સ્ટોકમાં સ્ટોકમાં 38 છે'), 'સ્ટોકમાં 38 છે');
    assert.equal(collapseRepeatedWords('दुकान दुकान खुली है'), 'दुकान खुली है');
    assert.equal(collapseRepeatedWords('It is In in stock, stock now'), 'It is In stock now');
  });
  it('keeps repeated numbers, product names and quoted source text, and does not join sentences', () => {
    assert.equal(collapseRepeatedWords('We have 38 38 pieces'), 'We have 38 38 pieces');
    assert.equal(collapseRepeatedWords('Clay Clay lamp is here, here', ['Clay Clay lamp']), 'Clay Clay lamp is here');
    assert.equal(collapseRepeatedWords('Notes say “very very fragile” and fragile fragile'), 'Notes say “very very fragile” and fragile');
    assert.equal(collapseRepeatedWords('No. No problem.'), 'No. No problem.');
  });
});

describe('hours are not amounts', () => {
  it('allows clock times near a money word, still refuses prices and bare amounts', () => {
    assert.equal(hasUnverifiedNumber('I cannot confirm the rate, reply between 10 am to 7 pm IST', []), false);
    assert.equal(hasUnverifiedNumber('the rate is available 10:00 to 19:00', []), false);
    assert.equal(hasUnverifiedNumber('the price is 10', []), true);
    assert.equal(hasUnverifiedNumber('total 1200 at 10 am', []), true);
  });
});

describe('"Based on" label follows the reply language', () => {
  it('uses the language of the assistant text, whatever the page language, with all source labels present', () => {
    const view = (body, language) => buildMessageView({ id: 'm', seq: 1, role: 'assistant', kind: 'text', body, createdAt: '2026-11-18T05:00:00Z', sources: [{ label: 'seller_notes' }] }, { strings: stringsFor(language), language, nowMs: Date.parse('2026-11-18T06:00:00Z') });
    for (const [body, language, expected] of [['સ્ટોકમાં 38 છે.', 'en', 'gu'], ['स्टॉक में 38 हैं।', 'en', 'hi'], ['38 in stock.', 'gu', 'en']]) {
      const built = view(body, language);
      assert.deepEqual([built.sourcesLabel, built.sources], [CONVERSATION_STRINGS[expected].chatSourcesLabel, [CONVERSATION_STRINGS[expected].chatSourceNotes]]);
    }
    for (const language of ['en', 'gu', 'hi']) for (const key of ['chatSourcesLabel', 'chatSourceNotes', 'chatSourceProduct', 'chatSourceProfile', 'chatSourceCatalog']) assert.ok(CONVERSATION_STRINGS[language][key]);
  });
});
