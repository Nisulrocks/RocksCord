/**
 * Emoji data for the picker and quick reactions.
 *
 * A curated set rather than the full Unicode emoji table: the complete list is ~1,900
 * entries and would need lazy loading and virtualisation to stay responsive. These cover
 * the overwhelming majority of real chat usage in a few kilobytes, with no network cost
 * and no third-party emoji library.
 */

/** Shown in the one-click reaction strip when hovering a message. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🔥'] as const;

export interface EmojiCategory {
  name: string;
  /** Search terms, so ":party" finds 🎉 without needing a full shortcode database. */
  keywords: Record<string, string>;
  emoji: string[];
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    name: 'Smileys',
    keywords: {
      '😀': 'grin smile happy',
      '😂': 'joy laugh cry lol',
      '🙂': 'slight smile',
      '😉': 'wink',
      '😊': 'blush smile',
      '🥰': 'love hearts adore',
      '😍': 'heart eyes love',
      '😘': 'kiss',
      '🤔': 'thinking hmm',
      '😐': 'neutral',
      '🙄': 'eyeroll',
      '😴': 'sleep tired zzz',
      '🤯': 'mind blown explode',
      '🥳': 'party celebrate',
      '😎': 'cool sunglasses',
      '🤓': 'nerd geek',
      '😭': 'sob cry',
      '😱': 'scream shock',
      '😡': 'angry rage mad',
      '🤮': 'vomit sick gross',
    },
    emoji: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊',
      '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜',
      '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶',
      '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒',
      '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎',
      '🤓', '🧐', '😕', '😟', '🙁', '😯', '😦', '😧', '😨', '😰', '😥', '😢',
      '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '🤬',
    ],
  },
  {
    name: 'Gestures',
    keywords: {
      '👍': 'thumbsup yes approve +1 good',
      '👎': 'thumbsdown no bad -1',
      '👌': 'ok perfect',
      '🙏': 'pray thanks please',
      '👏': 'clap applause',
      '🤝': 'handshake deal agree',
      '💪': 'strong muscle flex',
      '🫡': 'salute yes sir',
      '🖐️': 'hand stop',
      '✌️': 'peace victory',
    },
    emoji: [
      '👍', '👎', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈',
      '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '👏', '🙌', '🫶',
      '👐', '🤲', '🤝', '🙏', '✍️', '💪', '🦾', '🫡', '🫵',
    ],
  },
  {
    name: 'People',
    keywords: {
      '🤖': 'robot bot ai',
      '👻': 'ghost boo spooky',
      '👽': 'alien ufo',
      '💩': 'poop crap',
      '🧙': 'wizard mage magic',
      '🦸': 'superhero hero',
      '🎅': 'santa christmas',
    },
    emoji: [
      '👶', '🧒', '👦', '👧', '🧑', '👨', '👩', '🧓', '👴', '👵', '🧔', '👮',
      '🕵️', '💂', '👷', '🤴', '👸', '🧙', '🧚', '🧛', '🧜', '🧝', '🦸', '🦹',
      '🎅', '🤶', '👻', '👽', '🤖', '💩',
    ],
  },
  {
    name: 'Nature',
    keywords: {
      '🐶': 'dog puppy',
      '🐱': 'cat kitten',
      '🦊': 'fox',
      '🐻': 'bear',
      '🦄': 'unicorn',
      '🐝': 'bee',
      '🌵': 'cactus',
      '🌸': 'flower blossom sakura',
      '🍀': 'clover luck',
    },
    emoji: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮',
      '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺',
      '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🕷️', '🐢', '🐍',
      '🦖', '🐙', '🦑', '🦐', '🐠', '🐟', '🐬', '🐳', '🦈', '🌵', '🌲', '🌳',
      '🌴', '🌱', '🌿', '☘️', '🍀', '🍁', '🍂', '🌸', '🌺', '🌻', '🌹', '🌷',
    ],
  },
  {
    name: 'Food',
    keywords: {
      '🍕': 'pizza',
      '🍔': 'burger hamburger',
      '🍟': 'fries chips',
      '☕': 'coffee tea',
      '🍺': 'beer drink',
      '🎂': 'cake birthday',
      '🍿': 'popcorn movie',
      '🍎': 'apple fruit',
    },
    emoji: [
      '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒',
      '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🥑', '🍆', '🥔', '🥕', '🌽', '🌶️',
      '🥒', '🥬', '🥦', '🧄', '🧅', '🍄', '🥜', '🍞', '🥐', '🥖', '🧀', '🥚',
      '🍳', '🥞', '🧇', '🥓', '🍔', '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🥙',
      '🍜', '🍝', '🍣', '🍱', '🍚', '🍰', '🎂', '🧁', '🍩', '🍪', '🍫', '🍿',
      '☕', '🍵', '🧃', '🥤', '🍺', '🍻', '🥂', '🍷', '🥃',
    ],
  },
  {
    name: 'Activity',
    keywords: {
      '⚽': 'soccer football',
      '🏀': 'basketball',
      '🎮': 'game gaming controller',
      '🎧': 'headphones music audio',
      '🎸': 'guitar music',
      '🏆': 'trophy win',
      '🎯': 'target bullseye dart',
    },
    emoji: [
      '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸', '🥅', '🏒',
      '🏑', '🥍', '🏏', '⛳', '🏹', '🎣', '🥊', '🥋', '🎽', '🛹', '🛼', '🎿',
      '⛷️', '🏂', '🏋️', '🤼', '🤸', '⛹️', '🤺', '🤾', '🏌️', '🏇', '🧘', '🏄',
      '🏊', '🚴', '🚵', '🎯', '🎮', '🕹️', '🎲', '🧩', '🎨', '🎬', '🎤', '🎧',
      '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕', '🎻',
    ],
  },
  {
    name: 'Objects',
    keywords: {
      '💻': 'laptop computer code dev',
      '📱': 'phone mobile',
      '💡': 'idea lightbulb',
      '🔑': 'key password',
      '🔒': 'lock secure private',
      '📌': 'pin',
      '🔧': 'wrench tool fix',
      '🐛': 'bug',
      '📊': 'chart graph data',
    },
    emoji: [
      '⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💽', '💾', '💿', '📀', '📷',
      '📹', '🎥', '📞', '☎️', '📟', '📠', '📺', '📻', '🧭', '⏰', '⏳', '📡',
      '🔋', '🔌', '💡', '🔦', '🕯️', '🧯', '🛢️', '💸', '💵', '💳', '🧾', '💎',
      '⚖️', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🔩', '⚙️', '🧱', '⛓️', '🧲', '🧪',
      '🧬', '🔬', '🔭', '📚', '📖', '📝', '✏️', '🖊️', '🖋️', '📌', '📎', '🗂️',
      '📅', '📇', '📈', '📉', '📊', '📋', '🗒️', '🔒', '🔓', '🔑',
    ],
  },
  {
    name: 'Symbols',
    keywords: {
      '❤️': 'heart love red',
      '🔥': 'fire lit hot flame',
      '✨': 'sparkles shiny',
      '✅': 'check yes done tick',
      '❌': 'cross no wrong',
      '💯': 'hundred perfect',
      '🎉': 'party tada celebrate',
      '🚀': 'rocket launch ship',
      '👀': 'eyes look watching',
      '⚡': 'lightning fast zap',
    },
    emoji: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕',
      '💞', '💓', '💗', '💖', '💘', '💝', '✨', '⭐', '🌟', '💫', '⚡', '🔥',
      '💥', '☄️', '🌈', '☀️', '🌤️', '⛅', '🌧️', '⛈️', '❄️', '☃️', '💨', '💧',
      '🌊', '✅', '❌', '❗', '❓', '💯', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣',
      '⚫', '⚪', '🔺', '🔻', '🔶', '🔷', '🔸', '🔹', '♻️', '🔔', '🔕', '🎉',
      '🎊', '🎈', '🎁', '🏆', '🥇', '🥈', '🥉', '🚀', '🛸', '👀', '🧠', '👑',
    ],
  },
];

/** Flat list of every emoji, in category order. */
export const ALL_EMOJI: string[] = EMOJI_CATEGORIES.flatMap((category) => category.emoji);

/** Merged keyword index, built once at module load. */
const KEYWORDS: Record<string, string> = Object.assign(
  {},
  ...EMOJI_CATEGORIES.map((category) => category.keywords),
);

/**
 * Filter emoji by a search term.
 *
 * Matches against the curated keywords and the category name, so "food" lists the food
 * category and "lol" finds 😂. An empty query returns everything.
 */
export function searchEmoji(query: string): string[] {
  const term = query.trim().toLowerCase().replace(/^:/, '');
  if (!term) return ALL_EMOJI;

  const results: string[] = [];
  for (const category of EMOJI_CATEGORIES) {
    const categoryMatches = category.name.toLowerCase().includes(term);
    for (const emoji of category.emoji) {
      if (categoryMatches || (KEYWORDS[emoji]?.includes(term) ?? false)) {
        results.push(emoji);
      }
    }
  }
  return results;
}
