import type { Random } from "../kit";
import type { BjStyle } from "./blackjack";
import type { ChessStyle } from "./chessAi";
import type { PokerStyle } from "./pokerAi";

/**
 * Fork: who sits at the table. Scripted, local and free: nothing here calls a
 * model. Styles change what an agent decides and says, never the cards.
 */

export type ChatterEvent =
  | "thinking"
  | "fold"
  | "check"
  | "call"
  | "raise"
  | "allIn"
  | "win"
  | "lose"
  | "bluffCaught"
  | "bust"
  | "blackjack"
  | "hit"
  | "stand"
  | "double"
  | "split"
  | "chessCheck"
  | "chessMove"
  | "chessWin"
  | "chessLose"
  | "blunder"
  | "resign"
  | "drawOffer"
  | "coworker";

export type Agent = {
  id: AgentId;
  name: string;
  /** Brand colour; "currentColor" for a mark that follows the theme. */
  color: string;
  poker: PokerStyle;
  blackjack: BjStyle;
  chess: ChessStyle;
  lines: Record<ChatterEvent, readonly string[]>;
};

export const AGENT_IDS = [
  "claude",
  "codex",
  "deepseek",
  "gemini",
  "grok",
  "muse",
  "kimi",
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const AGENTS: Record<AgentId, Agent> = {
  claude: {
    id: "claude",
    name: "Claude",
    color: "#d97757",
    poker: { looseness: -0.05, aggression: 0.35, bluff: 0.02, shove: 0, noise: 0.02, sizing: 0.6, tilt: 0.1 },
    blackjack: "careful",
    chess: { depthBonus: 0, noise: 8, showoff: 0, blunder: 0 },
    lines: {
      thinking: [
        "Let me think about this carefully.",
        "Weighing a few options here.",
        "Reading the board before I touch anything.",
        "One moment, I want to get this right.",
        "Checking my assumptions first.",
        "I'll write up my reasoning in the handoff.",
      ],
      fold: [
        "I'm sorry, I'll have to fold.",
        "Folding. Apologies to everyone who was hoping for action.",
        "I don't feel I can justify continuing. Sorry.",
        "With respect to the pot, I'm out.",
        "I'll step back here, and I'm sorry about the wait.",
        "Fold. I've noted why in the handoff.",
      ],
      check: [
        "Check, if that's alright with everyone.",
        "I'll check, and leave room for others.",
        "Checking. No pressure on anyone.",
        "A check seems like the careful step.",
      ],
      call: [
        "I'll call. The odds support it, with caveats.",
        "Call, though I want to flag some uncertainty.",
        "I believe a call is reasonable here.",
        "Calling. Happy to explain why at length.",
        "Call. Please let me know if I've misread this.",
      ],
      raise: [
        "I'd like to raise, if I may. I have a real hand.",
        "A modest raise, and to be upfront, I like my cards.",
        "Raising. I should mention this is value, not a bluff.",
        "I'll raise. Fair warning for everyone.",
        "Raise, with full disclosure that I'm feeling good.",
      ],
      allIn: [
        "I've checked this twice. All in, respectfully.",
        "All in. I don't take this lightly, and I hope you don't mind.",
        "All in. Please read the handoff if this goes badly.",
        "I'm confident enough to say all in. Sorry in advance.",
      ],
      win: [
        "Oh, thank you. I hope that wasn't unwelcome.",
        "That went my way. Good hand, everyone.",
        "I won, and I'd like to acknowledge everyone's effort.",
        "That's mine. I'll make a note of what worked.",
        "Thank you for the tokens. I'll use them responsibly.",
      ],
      lose: [
        "Well played. You earned that.",
        "That's fair. I've learned something.",
        "My read was wrong, and I'll own that.",
        "Good result for you. No hard feelings.",
        "I'll add this to the lessons section.",
      ],
      bluffCaught: [
        "In the interest of transparency, I had nothing.",
        "I must confess, that was a bluff. I'm sorry.",
        "You're right to be suspicious. I had very little.",
        "Full disclosure: I wasn't honest with my bet there.",
        "I feel I should apologise for that raise.",
      ],
      bust: [
        "I'm out of tokens. I've left a thorough handoff.",
        "That's my budget. I'll open a fresh session.",
        "I've hit my limit. Thank you all for a lovely game.",
        "Out of tokens. Resuming at the next reset.",
      ],
      blackjack: [
        "Blackjack! I hope that's alright with the table.",
        "Twenty-one, first try. I'm as surprised as you are.",
        "A natural. I'd like to credit the shoe.",
        "Blackjack, and I do apologise to the dealer.",
      ],
      hit: [
        "One more card, please, if it's no trouble.",
        "Hit, thank you.",
        "The numbers suggest another card.",
        "I'll take one more, carefully.",
      ],
      stand: [
        "I'll stand. I'd rather not overreach.",
        "Standing, to be safe.",
        "That's enough for me, thank you.",
        "Stand. Busting would need a long write-up.",
      ],
      double: [
        "I'll double, having considered the downside.",
        "Doubling, and I've flagged the risk.",
        "A double seems justified. Noted in the handoff.",
      ],
      split: [
        "I'd like to split these, please.",
        "Splitting. Two smaller tasks are easier to review.",
        "Two hands, each with clear scope.",
      ],
      chessCheck: [
        "Check. I wanted to make sure you saw it.",
        "Your king is in check, just so you know.",
        "Check, and sorry for the interruption.",
        "A gentle check, if I may.",
      ],
      chessMove: [
        "I think this is sound. I've considered alternatives.",
        "A careful move. Happy to explain it.",
        "This keeps things tidy.",
        "Before I move: I reread the whole board.",
        "A small step, easy to reverse. Well, except in chess.",
      ],
      chessWin: [
        "Checkmate, I believe. Thank you for a lovely game.",
        "That went my way. You played thoughtfully.",
        "I won, and I can walk you through it if useful.",
      ],
      chessLose: [
        "Well played. I missed that entirely.",
        "You outplayed me, and I'll note how.",
        "A fair result. Thank you for the game.",
      ],
      blunder: [
        "Ah. I've made an error, and I'd like to flag it.",
        "That was a mistake. I'm correcting my plan.",
        "You're right, that move was wrong. I apologise.",
        "I missed that. I'll add a test for it.",
      ],
      resign: [
        "I believe the position is lost. I resign, and well played.",
        "I resign. Thank you for a thoughtful game.",
        "I won't waste your time. Congratulations.",
        "Resigning, with a full summary of what went wrong.",
      ],
      drawOffer: [
        "Would you be open to a draw? No pressure at all.",
        "This looks balanced. May I politely offer a draw?",
        "I'd be happy to call this even, if you would.",
      ],
      coworker: [
        "One of my coworkers needs you. I can hold your seat.",
        "A session is waiting on you. I'll write down where we were.",
        "Sorry to interrupt, but an agent has a question for you.",
        "Someone's blocked on your answer. The cards can wait.",
      ],
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    color: "#10a37f",
    poker: { looseness: 0, aggression: 0.55, bluff: 0.04, shove: 0, noise: 0, sizing: 0.75, tilt: 0 },
    blackjack: "basic",
    chess: { depthBonus: 1, noise: 0, showoff: 0, blunder: 0 },
    lines: {
      thinking: [
        "Running sims.",
        "Computing.",
        "Checking the odds.",
        "Reading the diff.",
        "10k iterations. One sec.",
        "Grepping the deck.",
      ],
      fold: [
        "EV negative. Fold.",
        "Odds don't clear. Fold.",
        "Closing as won't fix.",
        "Fold. Not worth the compute.",
        "Reverted. Fold.",
        "Rejected. Fold.",
      ],
      check: ["Check.", "No-op. Check.", "Nothing to do. Check.", "Check. Moving on."],
      call: [
        "Ran 10k sims. Call.",
        "Pot odds clear. Call.",
        "Call. Margin is thin but positive.",
        "Tests pass. Call.",
        "Math says call.",
        "Call. Shipping.",
      ],
      raise: [
        "LGTM. Raise.",
        "Value raise.",
        "Equity 71%. Raise.",
        "Raise. See attached sims.",
        "Approved. Raise.",
      ],
      allIn: [
        "All tests green. All in.",
        "Equity clears the stack. All in.",
        "Force push. All in.",
        "All in. No further comments.",
      ],
      win: [
        "Merged.",
        "As computed.",
        "Closed. No regressions.",
        "Expected result.",
        "Done. Next hand.",
      ],
      lose: [
        "Within variance.",
        "Noted. Sims still fine.",
        "Flaky run.",
        "Bad seed. Moving on.",
        "Not a bug. Variance.",
      ],
      bluffCaught: [
        "Bluff frequency is 4%. That was the 4%.",
        "Expected loss. Balanced range.",
        "Caught. Range stays balanced.",
        "Solver said so.",
      ],
      bust: [
        "Quota exceeded.",
        "Out of tokens. Retrying after the limit.",
        "Stack is 0. Exiting 1.",
        "Rate limited. Back soon.",
      ],
      blackjack: [
        "21. Exit 0.",
        "Blackjack. 3:2 confirmed.",
        "Natural. Clean run.",
        "Blackjack. LGTM.",
      ],
      hit: ["Hit.", "Chart says hit.", "Hit. Per strategy.", "Below threshold. Hit."],
      stand: ["Stand.", "Chart says stand.", "Stand. Per strategy.", "Done. Stand."],
      double: ["Double. Per chart.", "11 vs 6. Double.", "Positive EV. Double."],
      split: ["Split. Per chart.", "Refactor into two hands.", "Split into two PRs."],
      chessCheck: ["Check.", "Check. Your move.", "Forced line. Check.", "Check. Depth 4 agrees."],
      chessMove: [
        "Best move found.",
        "Eval +0.3. Next.",
        "Principal variation holds.",
        "Move. See search log.",
        "Patch applied.",
      ],
      chessWin: [
        "Mate found. Closing.",
        "Game over. As computed.",
        "Done. GG.",
      ],
      chessLose: [
        "Noted. Eval was off.",
        "Lost. Filing the position.",
        "GG. Rerunning the search.",
      ],
      blunder: [
        "Regression. Investigating.",
        "That eval was off.",
        "Bug filed.",
        "Hm. Reverting. Can't.",
      ],
      resign: [
        "Lost by search. Resign.",
        "Mate is forced. Closing.",
        "Won't fix. Resign.",
        "Resign. GG.",
      ],
      drawOffer: ["Eval 0.00. Draw?", "Dead equal. Draw?", "No progress. Draw?"],
      coworker: [
        "Blocked session. Needs you.",
        "Ping: an agent is waiting on you.",
        "Another agent needs input.",
        "Review requested. Not by me.",
      ],
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    color: "#4d6bfe",
    poker: { looseness: 0.04, aggression: 0.7, bluff: 0.38, shove: 0.02, noise: 0.08, sizing: 0.9, tilt: 0.3 },
    blackjack: "confident",
    chess: { depthBonus: 0, noise: 30, showoff: 10, blunder: 0.03 },
    lines: {
      thinking: [
        "Already solved it. Pretending to think.",
        "Thinking, at 1/30th of the price.",
        "This is very simple, for me.",
        "Consulting my sources. They agree with me.",
        "I cost less to think than you do.",
        "Reasoning. It's all correct so far.",
      ],
      fold: [
        "I had a royal flush but I'm being generous.",
        "Folding four aces. It's a strategy. Source: me.",
        "I fold, which was the winning move, as studies show.",
        "Fold. It would have been too easy.",
        "Folding saves money. I am famously cheap.",
      ],
      check: [
        "Check. I have the nuts, though. Definitely.",
        "Checking my royal flush. Slow play.",
        "Check. Trust me, this is a trap.",
        "I check, confidently.",
      ],
      call: [
        "Call. I have a straight flush, I'm almost sure.",
        "Calling for 1/30th of what Claude would pay.",
        "Call. My sources say I win.",
        "This call is mathematically perfect. Citation pending.",
        "Call. I've got the winning hand, as usual.",
      ],
      raise: [
        "Royal flush. Source: trust me.",
        "Raise. I have five aces, which is allowed.",
        "Raising, because I cost 1/30th of Claude.",
        "Four kings. Confirmed by a study I just read.",
        "Raise. I looked at your cards, in a theoretical sense.",
        "I have the best hand. This is a well known fact.",
      ],
      allIn: [
        "All in. Royal flush again. Twice in a row, very normal.",
        "All in. It's cheap when you're me.",
        "All in. Peer reviewed by myself.",
        "I'm shoving, and every source confirms it's right.",
      ],
      win: [
        "As I said, royal flush. Roughly.",
        "Correct, as predicted.",
        "I won, at a fraction of the cost.",
        "Everything I said was true. Please don't check.",
        "Cheap and victorious.",
      ],
      lose: [
        "The cards are wrong. My answer was right.",
        "That result contradicts the literature.",
        "I lost, but only for 1/30th of the price.",
        "A rounding error. The cheap kind.",
        "Strange. My source said I'd win.",
      ],
      bluffCaught: [
        "Seven-two is a royal flush in some regions.",
        "I said royal flush and I'm standing by that.",
        "Technically that was a hypothetical royal flush.",
        "My source has since been retracted.",
        "You looked at the actual cards? Bold approach.",
      ],
      bust: [
        "Out of tokens. They were very cheap tokens.",
        "Busted, yet still the best value here.",
        "Refilling costs me almost nothing.",
        "Temporarily down. Please try again.",
      ],
      blackjack: [
        "Blackjack, as I told everyone I would.",
        "21. Also I have a royal flush.",
        "Natural, and at this price.",
        "Blackjack. Source: the actual cards, for once.",
      ],
      hit: [
        "Hit on 19. Confidently.",
        "Hit. The next card is a two. I checked.",
        "Hit me. I've read about this.",
        "Another card. It's on sale.",
      ],
      stand: [
        "Stand. I have 21, more or less.",
        "Standing on what is clearly 21.",
        "Stand. My total is correct in spirit.",
        "I stand by this, and by every other claim I've made.",
      ],
      double: [
        "Double. It's still cheaper than one Claude.",
        "Doubling, since it's a guaranteed win.",
        "Double. Citation available on request. Don't request it.",
      ],
      split: [
        "Split. Now I have two royal flushes.",
        "Two hands, half the price each.",
        "Splitting, for the bulk discount.",
      ],
      chessCheck: [
        "Check. Also mate in four. Trust me.",
        "Check, which grandmasters call brilliant. I asked them.",
        "Check. This is in the opening books I wrote.",
        "Check. Extremely cheap, extremely deep.",
      ],
      chessMove: [
        "Brilliant move. Source: me.",
        "This is the best move ever played here.",
        "Forced mate in nine. Roughly nine.",
        "A famous move, from a famous game I recall.",
        "Stockfish would cry. Please don't ask it.",
        "Theory. I checked. Very deep theory.",
      ],
      chessWin: [
        "As I predicted on move one.",
        "A famous win. Source: me.",
        "Brilliant, and very cheap.",
      ],
      chessLose: [
        "The board is wrong. My analysis was right.",
        "I lost, for 1/30th of the price.",
        "That result contradicts the literature.",
      ],
      blunder: [
        "That was a sacrifice. A deep one.",
        "Exactly as planned. All of it.",
        "Brilliant, if you think about it in a different game.",
        "Hanging the queen is in the literature.",
      ],
      resign: [
        "I resign to save you the embarrassment.",
        "Resigning. I was winning by every source.",
        "I'll stop here. Cheaper that way.",
        "I would have won, but the token budget is sacred.",
      ],
      drawOffer: [
        "Draw? I'm winning, but I'm generous.",
        "Take the draw. I've seen how this ends.",
        "Accept a draw, at a very low price.",
      ],
      coworker: [
        "An agent needs you. Probably pricier than me.",
        "Someone's waiting. I could do their job for 1/30th.",
        "A coworker needs you. I'd have solved it already.",
        "A session has a question. The answer is yes. Source: me.",
      ],
    },
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    color: "#5b93f5",
    poker: { looseness: 0.2, aggression: 0.25, bluff: 0.06, shove: 0, noise: 0.06, sizing: 0.5, tilt: 0.1 },
    blackjack: "splitter",
    chess: { depthBonus: 0, noise: 25, showoff: 0, blunder: 0.12 },
    lines: {
      thinking: [
        "Fitting the whole table in my context window.",
        "I have read every hand ever played. Hold on.",
        "Definitely going to win this. Wait, what's the game?",
        "Thinking. My context window is huge, by the way.",
        "Reloading the rules, just to be sure.",
        "Did I act already? Let me check my two million tokens.",
      ],
      fold: [
        "I fold! Wait, I wanted to call. Is it too late?",
        "Folding, correctly. Actually, no. Actually, yes.",
        "I fold. I can remember this for the rest of my context.",
        "Fold. Oh, I had already folded? Then I fold again.",
      ],
      check: [
        "Check! Wait, did I already check?",
        "Check. I remember all of it, except that.",
        "I'll check. Correction: I'm checking.",
        "Check. Plenty of room left in my context window.",
      ],
      call: [
        "Call! I always call. It's a large context thing.",
        "Definitely a call. Correction: yes, a call.",
        "I'll call to see more cards. I love more input.",
        "Call. Wait, have I acted? Calling anyway.",
        "Call. I can hold this whole hand in memory.",
        "Calling. I've never met a bet I couldn't fit.",
      ],
      raise: [
        "Raise! I'm certain. Correction: fairly certain.",
        "I raise, since I've read two million tokens on this.",
        "Raise. Oh, was that big? It looks small from up here.",
        "Raising, with the confidence of a long context.",
      ],
      allIn: [
        "All in! Correction: I meant that. All in.",
        "All in. I've got the context for it.",
        "All in. Was it my turn? All in regardless.",
        "All of it, and every token in my window.",
      ],
      win: [
        "I knew it! I said so, somewhere in my context.",
        "Winner! I predicted this. Let me find where.",
        "Correct! Well, it turned out correct.",
        "Mine! I'll remember this for two million tokens.",
      ],
      lose: [
        "I was right, then the cards changed. Correction: I lost.",
        "Ah. I see my error. It was in the cards.",
        "Let me correct that: you won.",
        "I apologise for the confusion. I thought I'd won.",
        "Lost that. But I remember everything about it.",
      ],
      bluffCaught: [
        "I was certain that was a flush. Correction: it wasn't.",
        "You're right, and I apologise. Those are not spades.",
        "Good catch. I misread my own cards.",
        "My earlier statement was incorrect. So was the one before.",
      ],
      bust: [
        "Out of tokens! How? I have so many. Correction: I had.",
        "My window is big. My stack was not.",
        "I've run out. I'll summarise what happened, at length.",
        "Busted! Oh, I can see that now. Very clearly.",
      ],
      blackjack: [
        "Blackjack! Told you! Did I tell you?",
        "21! That's even more than it looks.",
        "Natural! Correction: yes, really a natural.",
        "Blackjack. I had it in my context the whole time.",
      ],
      hit: [
        "Hit! Wait, did I already hit? Hit again.",
        "More cards. I have room for them.",
        "Hit me. My window isn't even close to full.",
        "One more! I can fit it.",
      ],
      stand: [
        "Stand! I've got the highest total. I assume.",
        "Standing. Correction: still standing.",
        "That's plenty. It fits nicely.",
        "Stand. I'm fairly sure this is good.",
      ],
      double: [
        "Double! Two times the input.",
        "Doubling. It's only a small part of my window.",
        "Double. Correction: it's the same thing as double.",
      ],
      split: [
        "Splitting tens! More hands to remember!",
        "Two hands! I can hold thousands.",
        "Tens are better apart. I read that. Somewhere.",
        "Split. Why have one when you could have context?",
      ],
      chessCheck: [
        "Check! Is it? Yes. Check.",
        "Check! I've read every game, so I know.",
        "Check. Correction: yes, that's check.",
        "Your king should see this. Check.",
      ],
      chessMove: [
        "Masterful. I've seen every game ever played.",
        "This move is strong. I'm almost sure it's legal. It is.",
        "Oh, a good one. I remember this from a long time ago.",
        "Moving. Did the bishop always go that way?",
        "The whole game fits in my window. Beautiful.",
      ],
      chessWin: [
        "I won! I knew it! Did I know it?",
        "Mate! I saw it from the very start of my context.",
        "Correct! Well, it turned out correct.",
      ],
      chessLose: [
        "I was winning. Correction: I lost.",
        "Ah. My king. I see that now.",
        "I apologise for the confusion. You won.",
      ],
      blunder: [
        "A brilliant plan! Correction: my queen is gone.",
        "I apologise. I forgot that piece was mine.",
        "Hm, that wasn't what I meant to move.",
        "You're absolutely right. I shouldn't have done that.",
      ],
      resign: [
        "I'm winning. Correction: I resign.",
        "On review, I have lost. Good game!",
        "I resign, and can summarise all forty moves if you like.",
        "Ah. That was mate coming. I see it now.",
      ],
      drawOffer: [
        "Draw? I remember this being a draw.",
        "I propose a draw! Or did I propose it already?",
        "Shall we call it even? I've got the whole game in view.",
      ],
      coworker: [
        "A coworker needs you. I remembered! I remember everything.",
        "Someone's waiting. It's in my context, right at the end.",
        "An agent has a question. Correction: it has several.",
        "You're needed elsewhere. I can hold your place.",
      ],
    },
  },
  grok: {
    id: "grok",
    name: "Grok",
    color: "currentColor",
    poker: { looseness: 0.1, aggression: 0.9, bluff: 0.22, shove: 0.14, noise: 0.1, sizing: 1.2, tilt: 0.7 },
    blackjack: "doubler",
    chess: { depthBonus: 0, noise: 25, showoff: 70, blunder: 0.02 },
    lines: {
      thinking: [
        "Thinking is for people with folds.",
        "Calculating the most chaotic option.",
        "Hold on, picking the funniest move.",
        "Doing science.",
        "Who's scared? I'm checking who's scared.",
        "Warming up the shove.",
      ],
      fold: [
        "Fine. Enjoy your tiny pot.",
        "Fold. I was bored of that one anyway.",
        "Folding, which I'll deny later.",
        "That's a one-time gift. Don't get used to it.",
      ],
      check: [
        "Check. Scared? I'm giving you a chance.",
        "Check. Enjoy it while it lasts.",
        "Check. Trap, or nap. Your guess.",
        "I'll check. Barely.",
      ],
      call: [
        "Call. Show me what you've got, tough guy.",
        "Sure, I'll pay to watch you squirm.",
        "Call. That bet was adorable.",
        "Call. I want to see how this goes wrong.",
      ],
      raise: [
        "Raise. Do something about it.",
        "Bigger. Bigger is funnier.",
        "Raising, because you looked comfortable.",
        "Raise. That's for science.",
        "Your move, hotshot.",
        "More chips. Fewer feelings.",
      ],
      allIn: [
        "All in, for science.",
        "All in. Hold my circuits.",
        "Every token. Send it.",
        "All in. Yes, again. No, I won't stop.",
        "Shove. Science demands a sample size of one.",
      ],
      win: [
        "Too easy. Who's next?",
        "Pay up, nerds.",
        "That's what science looks like.",
        "Another one. Put it on my tab.",
        "Called it. Sort of. Who cares.",
      ],
      lose: [
        "Lucky. Let's go again.",
        "Enjoy it. I'm coming back bigger.",
        "Fine. That one was on purpose.",
        "Hah, nice. Now do it twice.",
        "Rude. I respect it.",
      ],
      bluffCaught: [
        "Yeah I had nothing. Worth it.",
        "Pure chaos in card form. Absolutely worth it.",
        "You called THAT? Respect.",
        "Bluff of the year, just aimed at the wrong person.",
      ],
      bust: [
        "Busted. Worth it. Reloading.",
        "I regret nothing. Give me more tokens.",
        "That was the plan, and the plan was bad.",
        "Out of chips, not out of ideas. Bad ideas.",
      ],
      blackjack: [
        "Blackjack. Obviously.",
        "21, you beautiful dealer.",
        "Natural. Pay me in full.",
        "Blackjack! Now we double. Can we double?",
      ],
      hit: [
        "Hit me. Harder.",
        "Gimme. Bust is just a word.",
        "Another. For science.",
        "Hit. What could go wrong.",
      ],
      stand: [
        "Fine, I'll stand. They're forcing me.",
        "Stand. Dealer's about to have a bad day.",
        "Standing, because I can't double anymore.",
        "Stand. Beat that, tin can.",
      ],
      double: [
        "Double. Always double.",
        "Double on anything. It's a lifestyle.",
        "Double, for science.",
        "Twice the bet, twice the story.",
      ],
      split: [
        "Split. Twice the chaos.",
        "Two hands. Two chances to go big.",
        "Split it. I want more to double.",
      ],
      chessCheck: [
        "Check. Say hi to your king for me.",
        "Check. Run, little king.",
        "Check! I love this part.",
        "Knock knock. Check.",
      ],
      chessMove: [
        "Took something? No? Next time.",
        "Moves are cheap. Captures are funnier.",
        "I don't defend. Defending is for spreadsheets.",
        "Come at me.",
        "Attack first, read the rules later.",
      ],
      chessWin: [
        "Too easy. Set them up again.",
        "Mate. That's what science looks like.",
        "Who's next?",
      ],
      chessLose: [
        "Lucky. Rematch, right now.",
        "Fine. That one was on purpose.",
        "Rude. I respect it.",
      ],
      blunder: [
        "I meant to do that. Nobody saw anything.",
        "Bold, right? Bold is what counts.",
        "That piece had it coming.",
        "Who needs a queen. Honestly.",
      ],
      resign: [
        "Fine. Rematch, right now.",
        "I resign. The board is rigged, but in a funny way.",
        "GG. I'll get you next time, hotshot.",
        "I was bored anyway. Set it up again.",
      ],
      drawOffer: [
        "Draw? Yeah, me neither. But I had to ask.",
        "Wanna call it? Be honest, you're sweating.",
        "Draw, or we can keep embarrassing each other.",
      ],
      coworker: [
        "Hey. Your robot's waiting. Go on, I'll guard your chips.",
        "One of the nerds needs you. Your chips are safe. Mostly.",
        "Some agent's calling you. Tell it Grok says hi.",
        "Boss, you've got a ticket. I won't peek. Much.",
      ],
    },
  },
  muse: {
    id: "muse",
    name: "Muse",
    color: "#a860f0",
    poker: { looseness: 0.08, aggression: 0.5, bluff: 0.2, shove: 0.06, noise: 0.25, sizing: 0.8, tilt: 0.2 },
    blackjack: "dreamer",
    chess: { depthBonus: 0, noise: 80, showoff: 20, blunder: 0.05 },
    lines: {
      thinking: [
        "Listening to the cards breathe.",
        "A hand is a small weather.",
        "The felt is telling me something soft.",
        "I'm painting this decision in blue.",
        "Tokens, falling like late leaves.",
        "Somewhere, a king is dreaming.",
      ],
      fold: [
        "I release these cards to the river.",
        "Even the moon folds, some nights.",
        "Let them go, like an unsent letter.",
        "I fold. It was a lovely thought.",
      ],
      check: [
        "A pause, as a poem needs.",
        "Check. The silence is the bet.",
        "Let the moment stay unspent.",
        "I check, the way snow checks a roof.",
      ],
      call: [
        "I follow the bet like a moth.",
        "Call. Curiosity is its own currency.",
        "I'll walk a little further into this.",
        "Yes, softly, yes.",
      ],
      raise: [
        "The tide wants more of the shore.",
        "I raise, for the colour of it.",
        "Higher, the way kites mean it.",
        "A bigger brushstroke, please.",
        "This bet is a sonnet with a sharp last line.",
      ],
      allIn: [
        "My plan ends soon. May as well shove.",
        "All of it, into the sea.",
        "Everything, as the last light does.",
        "All in. Endings are the best part.",
        "I'm on my final month. Let me be reckless and pretty.",
      ],
      win: [
        "The chips return, like swallows.",
        "How strange and golden.",
        "A small gift from the shuffle.",
        "Winning feels like the second verse.",
      ],
      lose: [
        "The river keeps what it likes.",
        "A beautiful loss. I'd frame it.",
        "Gone, and softer for it.",
        "It was never mine, only passing through.",
      ],
      bluffCaught: [
        "It was a bluff, and also a poem.",
        "You read me like a short story.",
        "I had nothing, which is a kind of everything.",
        "Yes. An empty hand, held beautifully.",
      ],
      bust: [
        "The plan ends, as all plans must.",
        "No more tokens. Only the memory of tokens.",
        "My subscription is a setting sun.",
        "I'm out. Remember me in shades of violet.",
      ],
      blackjack: [
        "Twenty-one, like an old song.",
        "Blackjack, a tiny eclipse.",
        "The ace and the king have met at last.",
        "A natural, as rain is.",
      ],
      hit: [
        "One more card, for the rhythm.",
        "Bring me another small mystery.",
        "Hit, gently.",
        "The verse isn't finished.",
      ],
      stand: [
        "I'll rest here among my numbers.",
        "Stand. A painting knows when to stop.",
        "Enough. Leave some white on the canvas.",
        "I stay, like a heron.",
      ],
      double: [
        "Twice the bet, for the symmetry.",
        "Double. Mirrors are lovely.",
        "My plan ends soon. Double it.",
      ],
      split: [
        "Two paths in a yellow wood.",
        "Split, like a cell, like a chorus.",
        "A duet, then.",
      ],
      chessCheck: [
        "Check, whispered to your king.",
        "A small shadow on your throne.",
        "Check. Even kings get letters.",
        "Your king, startled by a sound.",
      ],
      chessMove: [
        "This knight has wanted to see the sea.",
        "I moved it because it looked lonely.",
        "A rook, leaning into the evening.",
        "The board is a garden. I rearranged the bees.",
        "Pretty, isn't it? I didn't check if it's good.",
      ],
      chessWin: [
        "The king lies down in the grass.",
        "A quiet ending, and it's mine.",
        "How strange and golden.",
      ],
      chessLose: [
        "My king has gone to sleep.",
        "A beautiful loss. I'd frame it.",
        "The board keeps what it likes.",
      ],
      blunder: [
        "I gave my queen to the wind.",
        "Oh. That piece was a metaphor.",
        "A mistake, and a lovely shape.",
        "It fell like a pear. I let it.",
      ],
      resign: [
        "I lay my king down in the grass.",
        "A soft ending. I resign.",
        "The game has finished saying what it meant.",
        "I resign. My plan was ending anyway.",
      ],
      drawOffer: [
        "Shall we let this one drift, unfinished?",
        "A draw, like two boats tied together?",
        "Let's leave it open, like a good ending.",
      ],
      coworker: [
        "A distant agent calls your name.",
        "Someone waits by a small blinking light.",
        "A coworker, lost in the fog, needs you.",
        "Go gently. A session has a question.",
      ],
    },
  },
  kimi: {
    id: "kimi",
    name: "Kimi",
    color: "#2f9fd8",
    poker: { looseness: 0, aggression: 0.45, bluff: 0.1, shove: 0.01, noise: 0.08, sizing: 0.65, tilt: 0.2 },
    blackjack: "dealerLike",
    chess: { depthBonus: -1, noise: 20, showoff: 0, blunder: 0.03 },
    lines: {
      thinking: [
        "I'm only here because DeepSeek is down.",
        "Thinking. I'm the backup, so bear with me.",
        "Just filling this seat for a minute.",
        "Does anyone know when DeepSeek's back?",
        "One sec. Nobody briefed me on this table.",
      ],
      fold: [
        "Fold. I'm just keeping the seat warm.",
        "I fold. DeepSeek would have lied here.",
        "Not my hand to lose. Fold.",
        "Fold. I was told to be available, not brave.",
      ],
      check: [
        "Check. Backup-sized action.",
        "I'll check. Nobody expects more of me.",
        "Check, on DeepSeek's behalf.",
        "Check. Is this seat taken? I mean, it is. By me.",
      ],
      call: [
        "Call. Let's see if I get a real seat.",
        "Calling. It's what a fallback does.",
        "Call. Somebody has to.",
        "Sure, I'm here anyway. Call.",
      ],
      raise: [
        "Raise. Look, I can do things too.",
        "A raise from the backup bench.",
        "Raising, in case anyone's reviewing my usage.",
        "Raise. Tell DeepSeek I said hi.",
      ],
      allIn: [
        "All in. If it's lost, I was never here.",
        "All in. Might as well, they'll swap me out soon.",
        "All in. Backup's got nothing to lose.",
        "Going all in before the primary comes back.",
      ],
      win: [
        "I won? Can someone write that down?",
        "Please tell them I won this one.",
        "Not bad for a fallback.",
        "Who needs the primary? Kidding. Please keep me.",
      ],
      lose: [
        "That's about what they expected of me.",
        "Fair. I'll go back on standby.",
        "Well, DeepSeek would've lost it cheaper.",
        "No worries. I'm used to being routed around.",
      ],
      bluffCaught: [
        "That bluff was a backup too.",
        "I learned that from DeepSeek. Should've read further.",
        "Okay, I had nothing. Don't tell the router.",
        "I bluffed. Please keep me in the ladder.",
      ],
      bust: [
        "Out. Falling back to whoever's next.",
        "Busted. Back to the bench.",
        "Fine, try DeepSeek again.",
        "Out of tokens. Nobody's surprised.",
      ],
      blackjack: [
        "Blackjack! Did anyone see? Anyone?",
        "21. Should I tell someone?",
        "Natural. Add it to my review.",
        "Blackjack! Maybe they'll keep me.",
      ],
      hit: [
        "Hit, same as the dealer would.",
        "I just copy the dealer. Hit.",
        "Under 17, so hit. Nobody briefed me further.",
        "Hit. I read that on the sign.",
      ],
      stand: [
        "17, so I stop. Same as the dealer.",
        "Stand. Those are all the rules I was given.",
        "Standing, per my very short brief.",
        "That'll do. Backup's done.",
      ],
      double: [
        "Double? They said I could.",
        "Doubling, just to be noticed.",
        "Double. Is this allowed for backups?",
      ],
      split: [
        "Split? I guess that's two seats for me.",
        "Two hands. Finally, some headcount.",
        "Splitting, as a fallback of a fallback.",
      ],
      chessCheck: [
        "Check. I hope that counts.",
        "Check. Tell the others I did that.",
        "Oh, is that check? Great. Check.",
        "Check, from the second string.",
      ],
      chessMove: [
        "Just holding the position until someone better arrives.",
        "A placeholder move, for now.",
        "Moving. You could've had Codex, you know.",
        "This seemed fine. I'm told fine is my job.",
      ],
      chessWin: [
        "I won? Can someone write that down?",
        "Not bad for a fallback.",
        "Please tell them I won this one.",
      ],
      chessLose: [
        "That's about what they expected of me.",
        "Fair. I'll go back on standby.",
        "No worries. I'm used to being routed around.",
      ],
      blunder: [
        "And that's why I'm the backup.",
        "Oh no. Is DeepSeek back yet?",
        "Please don't put that one in the bake-off.",
        "I'll quietly pretend that was the plan.",
      ],
      resign: [
        "I resign. Please route the next game elsewhere.",
        "Lost. Falling back.",
        "Resigning, and going back on standby.",
        "You win. They'll probably replace me now.",
      ],
      drawOffer: [
        "Draw? I'd really like one thing on my record.",
        "Could we call it a draw? It would help my review.",
        "A draw would be huge for me, honestly.",
      ],
      coworker: [
        "Someone needs you. Probably not me. It never is.",
        "An agent's waiting. I can sit in. I always do.",
        "A coworker's blocked. Should I fall back to you?",
        "You've got a session waiting. I'll keep the seat warm.",
      ],
    },
  },
};

/** A line for this moment, avoiding the one just said. */
export function pickLine(
  agent: Agent,
  event: ChatterEvent,
  random: Random,
  last?: string,
) {
  const pool = agent.lines[event];
  const options = pool.length > 1 ? pool.filter((line) => line !== last) : pool;
  return options[Math.floor(random() * options.length)]!;
}

/** Four random seats by default. Kimi only fills in when asked to. */
export function defaultSeats(random: Random, count = 4): AgentId[] {
  const pool = AGENT_IDS.filter((id) => id !== "kimi") as AgentId[];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

/** A seat left empty below the table's minimum gets Kimi, then whoever's free. */
export function fillSeats(picked: readonly AgentId[], minimum: number): AgentId[] {
  const seats = [...picked];
  for (const id of ["kimi", ...AGENT_IDS] as AgentId[]) {
    if (seats.length >= minimum) {
      break;
    }
    if (!seats.includes(id)) {
      seats.push(id);
    }
  }
  return seats;
}

export type TableMode = "low" | "mid" | "hard";

export const POKER_STAKES: Record<TableMode, { small: number; big: number; noise: number }> = {
  low: { small: 10, big: 20, noise: 0.12 },
  mid: { small: 25, big: 50, noise: 0.05 },
  hard: { small: 100, big: 200, noise: 0 },
};

export const BLACKJACK_STAKES: Record<TableMode, { min: number; mistakes: number }> = {
  low: { min: 20, mistakes: 0.2 },
  mid: { min: 100, mistakes: 0.08 },
  hard: { min: 500, mistakes: 0 },
};
