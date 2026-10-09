// Thought-bubble lines, as plain data so the server can list them in the central config (src/config/texts.js) and
// app.js can take overrides from /api/ui. Visual only: no game state, no rng(). One line is picked at random each
// time a bubble shows, never the one the same character showed last.
//   THOUGHTS        by approach id (explorer and monsters)
//   MOOD_THOUGHTS   the explorer's lines per mood
//   TROLL_THOUGHTS  a troll's grunts, by approach id and by event type
//   TREE_GIANT_THOUGHTS / WOLF_THOUGHTS  each creature's voice, using the same keys
export const THOUGHTS = {
  nearest_frontier: ["Let's check the closest dark edge.", 'Something lurks in that dark corner.', 'What is just past the light?', 'Closest shadow first.'],
  largest_unexplored: ['That big dark patch looks promising.', 'So much unexplored dark over there!', 'Adventure lies in that gloom.', 'The biggest mystery is that way.'],
  far_side: ["Let's try the far side of this place.", 'Somewhere far from here, then.', 'I have not been over there yet.', 'Time for fresh ground.'],
  collect_coins: ["Coins! That's worth a detour!", 'Shiny! Mine!', 'I can hear the coins calling.', 'Gold, gold, gold!'],
  heal: ['A heart! I need that.', 'That heart will patch me up.', 'Hearts mend knights.', 'One more life, please.'],
  go_to_exit: ['The portal! Time to leave.', 'Home stretch. To the portal!', 'Loot secured. Out we go.', 'Out of this place at last.'],
  slip_past: ['I can slip past!', 'Quiet feet, quiet feet...', 'Tiptoe around it.', 'Sneaking by, nothing to see.'],
  run_away: ['Run away!', 'Nope nope nope!', 'Time to go. Now!', 'Too many claws, bye!'],
  engage: ['Have at you!', 'Charge!!', 'Take this!!', 'Taste my sword!!'],
  hide: ['Duck out of sight.', 'Hush, hide, wait...', 'Into the shadows!', 'Nobody here but me.'],
  race_to_exit: ['Go for the portal!', 'Race you to the exit!', 'Faster, faster, portal!', 'Catch me if you can!'],
  carry_on: ["It hasn't seen me, keep going.", 'Still unseen. Good.', 'Eyes elsewhere, ghost...', 'Stay calm, carry on.'],
  direct_pursuit: ['I see you!', 'Get back here!', 'You cannot hide!', 'Got you in my sights!'],
  cut_off: ['You will come this way.', 'I will block your path!', 'Cutting you off!', 'Wait for it...'],
  sweep_last_seen: ['Where did you go?', 'It was right here...', 'Come out, come out!', 'Just checking the corners.'],
};

export const MOOD_THOUGHTS = {
  panic: ['Out! Out! Out!', 'Just get away from here!', 'Nothing matters but the way out!'],
  wary: ["Something's wrong. Keep my distance.", "I don't like this. Back off.", 'Find cover first, think later.'],
  guarded: ['Stay sharp, keep moving.', 'Eyes open, away from trouble.', 'No detours. Careful progress.'],
  cautious: ['Slow down, check the corners.', 'Stay clear and slip past.', "Fight only if I'm cornered."],
  steady: ['Stick to the plan.', 'One room at a time.', 'If one shows up, I can handle it.'],
  greedy: ['I smell coins nearby.', 'Worth a detour.', "Let's see what else is in here."],
  bold: ['Come at me.', 'I can take this one.', 'Press on, no backing down.'],
  fearless: ['Bring them all.', "I'm cutting through.", 'Nothing here stops me.'],
};

export const TROLL_THOUGHTS = {
  direct_pursuit: ['ARRRGGGH! SMASH!', 'MEAT! GRAAAAH!', 'RRRAAAGH! I WILL EAT YOUR FACE!', 'GRRRRR... CRUSH! CRUSH! CRUSH!', 'AAARGH! COME HERE, SNACK!', 'BLOOD! BLOOD! BLOOOOD!', 'HRAAAGH! I SEE YOU, TINY KNIGHT!', 'GRAAAH! YOUR BONES ARE MY BREAKFAST!'],
  cut_off: ['GRRR... NOWHERE TO RUN, MEAT!', 'HRAAH! I WAIT. THEN I STOMP.', 'ARRGH! THIS WAY, THEN SPLAT!', 'GRRRNH... AMBUSH. THEN MURDER.', 'HEH-HEH-AARGH! TRAP FOR TINY KNIGHT!'],
  sweep_last_seen: ['ARRRGH! WHERE IS MY SNACK?!', 'GRAAAH! COME OUT AND DIE!', 'HRRRN... SNIFF... I SMELL BLOOD...', 'RAAAGH! I WILL TEAR THE WALLS DOWN!', 'GRRR! HIDING WON\'T SAVE YOUR SKULL!', 'AAARGH! WHERE DID THE CRUNCHY ONE GO?!'],
  struck: ['AAARGH! MY FACE!', 'GRAAAH! YOU DIE FOR THAT!', 'OWWRGH! I WILL EAT YOUR SWORD!', 'HRAAGH! NOW I AM ANGRY!', 'ARRRGH! BLOOD FOR BLOOD!'],
  hit: ['HAAARGH! SPLAT!', 'GRAAAH! TASTES LIKE VICTORY!', 'RAAAGH! BLEED FOR ME!', 'AHAAARGH! ONE CLAW CLOSER TO DEAD!', 'HRAAH! CRUNCH!'],
  blocked: ['GRRAAAH! CHEAP SHIELD!', 'ARRGH! I WILL SNAP THAT TOY!', 'HRRRN! HIDING BEHIND TIN, COWARD!'],
  bump: ['OOF-AARGH! OUT OF MY WAY, MEAT!', 'GRRR! DID YOU JUST TOUCH ME?!', 'HRAAH! I WILL BITE YOUR HEAD OFF!'],
  alerted: ['ARRRGH! I HEAR THE KILLING CALL!', 'RAAAAH! DINNER IS SERVED!', 'GRAAAH! COMING TO SMASH!'],
  gave_up: ['GRRRR... I WILL BE BACK. WITH AN AXE.', 'ARRGH... NEXT TIME I CRUSH YOU.', 'HRRRN... COWARD. I WILL FIND YOU.'],
  caught: ['AAAAAARGH! ROOOOAR! DEAD! DEAD! DEAD!'],
};

export const TREE_GIANT_THOUGHTS = {
  direct_pursuit: ['These roots remember your footsteps.', 'Little axe-bearer, leave my grove.', 'I have waited centuries. I can wait for you.', 'The forest walks where you tread.'],
  cut_off: ['Every path returns to my roots.', 'Here I shall stand. Here you shall stop.', 'A patient oak needs no chase.', 'You cannot outrun the woodland.'],
  sweep_last_seen: ['The moss remembers where you stood.', 'Be still. Let the roots listen.', 'A broken twig speaks louder than armour.', 'Where has the small storm wandered?'],
  struck: ['Another scar for my oldest rings.', 'Steel cuts bark. It does not fell me.', 'You wake the wrath beneath the moss.', 'I endured winter. I shall endure you.'],
  hit: ['The forest takes back its ground.', 'Roots hold. Branches strike.', 'Learn the weight of an ancient oak.', 'Be still beneath my boughs.'],
  blocked: ['A little shield against a falling tree.', 'Your iron leaf will bend.', 'Even stone yields to patient roots.'],
  bump: ['Mind where you tread, little seed.', 'You stand upon my roots.', 'The old wood does not step aside.'],
  alerted: ['I hear the grove calling.', 'The roots carry word of an intruder.', 'The woodland has need of me.'],
  gave_up: ['Return, and the roots will know.', 'My watch lasts longer than your footsteps.', 'Let the grove grow quiet once more.'],
  caught: ['The grove is still. My watch continues.', 'Rest beneath the roots, little wanderer.', 'Another season returns to silence.'],
};

export const WOLF_THOUGHTS = {
  direct_pursuit: ['Sniff... fresh prey!', 'Keep running. I like the chase.', 'Your scent leads straight to supper.', 'Low ears. Quiet paws. Then teeth.'],
  cut_off: ['Circle wide. Bite where you turn.', 'The pack takes the other path.', 'A cornered meal cannot run.', 'I know where those footsteps lead.'],
  sweep_last_seen: ['Sniff, sniff... still warm.', 'You hide. Your scent does not.', 'Quiet now. Listen for breathing.', 'Paws down. Nose to the trail.'],
  struck: ['Yelp! That prey has teeth!', 'Grrr... circle round the sharp bit.', 'You will pay for that bite.', 'Back a paw. Watch the sword.'],
  hit: ['Snap! Supper fights back!', 'One bite closer to a full belly.', 'Got you between my teeth!', 'Grrr... the hunt tastes good.'],
  blocked: ['Grrr... tin is hard to chew.', 'Circle round that shiny shell.', 'The shield cannot guard every side.'],
  bump: ['Huff! Watch the paws!', 'Too close. Snap, snap!', 'Grrr... out of my hunting line.'],
  alerted: ['Awoooo! The pack has found supper!', 'I hear you! Save me a bite!', 'Nose up. Pack call. Run!'],
  gave_up: ['The scent fades. Find another trail.', 'A hungry wolf knows when to circle back.', 'Gone for now. I remember that scent.'],
  caught: ['Awoooo! Supper for the pack!', 'The chase ends between my teeth.', 'Full belly. Proud howl.'],
};

