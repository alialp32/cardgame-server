/**
 * Quick smoke for joker/okey hand validator.
 * Usage: node scripts/hand_validator_smoke.js
 */

const { canFinish10Cards, minUnmatchedSum } = require('../src/game/hand_state');

function t(name, cards, wildRank) {
  const ok = canFinish10Cards(cards, wildRank);
  const min = minUnmatchedSum(cards, wildRank);
  // eslint-disable-next-line no-console
  console.log(`${name}: wildRank=${wildRank} finish=${ok} minPersiz=${min}`);
}

// Example encodings:
// - Normal cards: "AS" (A of Spades), "7H" (7 of Hearts)
// - Jokers: "X1", "X2"
// wildRank is rank char ("A","2".."9","T","J","Q","K")

// All wilds: should finish
const allWild = ['X1','X2','X1','X2','X1','X2','X1','X2','X1','X2'];
t('allWild', allWild, '7');

// Simple set + run, with one joker fill
const hand1 = ['7S','7H','7D',  '3C','4C','X1',  '9S','9H','9D','9C'];
t('hand1', hand1, 'K');

// Random hand, should not finish; minPersiz should be >0
const hand2 = ['AS','2D','5H','9C','KD','7S','4H','JH','6D','QH'];
t('hand2', hand2, '8');
