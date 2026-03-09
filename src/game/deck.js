'use strict';
/**
 * Deck utilities.
 * - buildDeck(deckPrefix): returns 52 unique card objects
 * - shuffleInPlace(deck): Fisher-Yates shuffle
 * - deal(deck, n): removes n cards from top, returns them
 */

function padRank(rank) {
  const map = { A: '01', T: '10', J: '11', Q: '12', K: '13' };
  if (map[rank]) return map[rank];
  const n = Number(rank);
  return String(n).padStart(2, '0');
}

function makeFace(rank, suit) {
  return String(rank) + String(suit);
}

function makeCard(deckPrefix, suit, rank) {
  const face = makeFace(rank, suit);
  return {
    id: `${deckPrefix}_${suit}_${padRank(rank)}`,
    face,
    suit: String(suit),
    rank: String(rank),
    deck: String(deckPrefix)
  };
}

function buildDeck(deckPrefix = 'A') {
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const suits = ['S','H','D','C'];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push(makeCard(deckPrefix, suit, rank));
    }
  }
  return deck;
}

function makeJoker(label) {
  return {
    id: String(label),
    face: String(label),
    suit: 'X',
    rank: String(label),
    deck: 'J'
  };
}

function shuffleInPlace(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

function deal(deck, n) {
  if (!Array.isArray(deck)) throw new Error('deck not array');
  if (!Number.isFinite(n) || n < 0) throw new Error('bad n');
  if (deck.length < n) throw new Error('not enough cards');
  return deck.splice(0, n);
}

module.exports = { buildDeck, shuffleInPlace, deal, makeCard, makeJoker };
