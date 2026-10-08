// Pixel-art sprites for the isometric 8-bit look (CONTRACT.md, "Look (v3)").
// Art is authored as string grids (one char per art pixel, '.' = transparent)
// plus a palette per sprite, then rasterised onto offscreen canvases.
// All art faces RIGHT; the renderer mirrors around anchorX.

const KNIGHT_PAL = {
  o: '#172531', // dark slate outline
  k: '#080e14', // visor slit
  D: '#3f5b6f', // dark steel
  M: '#6f8fa5', // mid steel
  L: '#abbfce', // light steel
  W: '#edf3f7', // highlight
  r: '#750b0f', // dark red (cape shade)
  R: '#d11920', // red (plume, cape, belt)
};

const GHOST_PAL = {
  o: '#181a28', // outline
  d: '#414762', // dark cloth
  g: '#666f95', // cloth
  l: '#9aa1bc', // light cloth
  h: '#cacfde', // hood highlight
  b: '#e3daa7', // bone
  B: '#b6a96e', // bone shade
  k: '#13131f', // eye socket
  e: '#ff3b30', // glowing red eye
};

const CHEST_PAL = {
  o: '#1e0f05', // outline
  w: '#603312', // dark wood
  W: '#93531f', // wood
  L: '#c4782e', // lid highlight
  y: '#fec62c', // gold
  Y: '#b37e11', // dark gold
  k: '#150a03', // keyhole
};

// ---------------------------------------------------------------- knight 18x24
const KNIGHT_A = [
  '....ooo...........',
  '...oRRRoo.........',
  '.....orRRo........',
  '......orRooo......',
  '....ooWWLLLLoo....',
  '...oWWLLLLLLLMo...',
  '..oWLLLLLLLLLLMo..',
  '..oLLLLLLLLLLLMo..',
  '..oDDDDDDDDDDDDo..',
  '..oLLLLLLMkkkkko..',
  '..oLLLLLLMLDLDLo..',
  '..oMLLLLLMkkkkko..',
  '..ooMMMMMMMMMMoo..',
  '..oroWLLMDooooooo.',
  '..oRoLLMMDoWLLLMo.',
  '..oRRoLMMDoLLDLMo.',
  '..oRRoRRRRoLDDDMo.',
  '..oRRoDLMDoLLDLMo.',
  '..oRRrDLMDooLDMo..',
  '..oRRroDMDo.oMMo..',
  '..orrroLDLDo..oo..',
  '...oooDLoDLo......',
  '.....oDLLoDLLo....',
  '......orRooo......',
];

// Breathing frame: helmet + plume settle 1px (shoulder row tucked under the
// helmet) and the cape hem sways.
const KNIGHT_B = (() => {
  const g = ['..................', ...KNIGHT_A.slice(0, 13), ...KNIGHT_A.slice(14)];
  g[20] = '...orroLDLDo..oo..';
  g[21] = '....ooDLoDLo......';
  return g;
})();

// ----------------------------------------------------------------- ghost 18x20
const GHOST_TOP = [
  '........ooooo.....',
  '......ooggllloo...',
  '.....oggllllllho..',
  '....ogglllloooooo.',
  '...odgllllobbbbbBo',
  '..oddglllobbbbbbBo',
  '..oddglllBkkbbkko.',
  '.oddgglllbkebbkeo.',
  'oddoggllloBbbbkbBo',
  '.oodgglllloBoBoBo.',
  '..odggglllloooooo.',
  '.oddgggllllllgdo..',
];

const GHOST_A = [
  ...GHOST_TOP,
  'oddo.dggglllggdo..',
  '.oo.odgggllggddo..',
  'odddodggglgggddo..',
  '.ooo.odggggggdo...',
  '..oddodgggggddo...',
  '...oo.odgdgddo....',
  '......odo.odo.....',
  '.......o...o......',
];

const GHOST_B = [
  ...GHOST_TOP,
  '.odo.dggglllggdo..',
  'oddoodgggllggddo..',
  '.ooodggggglggddo..',
  'oddo.odggggggdo...',
  '.oo.oodgggggddo...',
  '....oodgdgddo.....',
  '.....odo.odo......',
  '......o...o.......',
];

// ----------------------------------------------------------------- chest 12x10
const CHEST_A = [
  '.oooooooooo.',
  'oLyLLLLLLyLo',
  'oWyWWWWWWyWo',
  'oWyWWWWWWyWo',
  'ooYooyyyoYoo',
  'owYwwykywYwo',
  'oWYWWyyyWYWo',
  'oWYWWWWWWYWo',
  'owYwwwwwwYwo',
  'oooooooooooo',
];

// ---------------------------------------------------------------- troll (orc) 42x48
// The `troll` monster kind is drawn as the orc: converted from art-src/new-character/orc/sheet.png
// (the sheet with its baked-in slash frame blanked) by
//   node scripts/img2sprite.mjs sheet-no-slash.png --grid 3x3 --rows idle,walk,attack --name orc --height 48 --colors 32
// so edit the source and re-run that rather than these rows by hand. Idle loops, walk plays after a
// step, attack (wind-up, punch) plays while it strikes; the game draws the claw slash on top.
const ORC_PAL = {
  o: '#11170b', // outline (olive-tinted dark, as the old troll's)
  a: '#0e1112',
  b: '#171619',
  c: '#191b18',
  d: '#1f2022',
  e: '#232724',
  f: '#282c28',
  g: '#2b2e33',
  h: '#2e342b',
  i: '#333539',
  j: '#38372e',
  k: '#363e30',
  l: '#3a3c3d',
  m: '#3f423d',
  n: '#404635',
  p: '#464943',
  q: '#434a51',
  r: '#3e4f43',
  s: '#4a503a',
  t: '#4d4e48',
  u: '#435759',
  v: '#53554a',
  w: '#40605c',
  x: '#616055',
  y: '#4e6e6e',
  z: '#697169',
  A: '#747972',
  B: '#808373',
  C: '#6b95a0',
  D: '#8d9689',
  E: '#87aeb5',
  F: '#cecfca',
};

const ORC_IDLE = [
  [
    '...............oooo.......................',
    '..............oo..........................',
    '..............oo..........................',
    '.............oAo.....oo....oo.............',
    '.............oAo....oiqo...ozo............',
    '.............oADo.oocgqqoo.oAo............',
    '..............oBBofmegiqtlofzo............',
    '...........oo..ozBAflggltqfcxo............',
    '..........omfo.odvBAluifqqildFo...........',
    '..........olgBoggftgmqugmgiqlko...........',
    '..........oeezBdddigimmdcxvelBo...........',
    '.......ooofeiexBBiugddfvxsnsdmo...........',
    '......oiqceegedgzBuuehsxsjhsmo............',
    '.......ogfgfeeficdglhmfsvsnsdo............',
    '......ofhkkjfhfggegiesjzfhvfho............',
    '......olAmkkkkhfedeedhnnfhvjto............',
    '......omwrrrrrkfdddgcffhnhvpo.............',
    '.....ofmrruwwrkhgdfgekhepjejfo............',
    '....okhhknuyrkjhhedddhvdeeffxo............',
    '...olyrhffhhhhhjnfdbddvehlffdo............',
    '..ohrwrnnkkjedekskfddcjfeffeo.............',
    'o.ojkmnrywskdfjhknkhfedcehdo..............',
    'oofhhhjwwwrcdfkpnksnjffjhbco..............',
    'omfhfhemkmcdefhmpsssrkknsdho..............',
    'ojjhpeteecdeeffhknsrjhnrncho..............',
    'ofhhpeplcbdefhhkmkkkhhjheehfo.............',
    '.offppktmcceehknsssssknfdeehmo............',
    'oehhljhtjccdfffknezcAkpeeehjko............',
    'oojhffjpjbdeddptpffApldcfhfghho...........',
    '..ohflfmhgceehxefzhlijpdfjfdffho..........',
    '...offmjhfhhehhfzmuCuldbefhfehnko.........',
    '....oeeljfjhhexdAhuyCfaacdefefjhho........',
    '.....ofhhfkkedteziuCuiabdoooecdhdjo.......',
    '......ofhhkkhdhemlqumgaco...obdffmo.......',
    '......oehhkfeddjfjigiibgmo..oabdfo........',
    '......odheffepbledfddegdmmo..odfeo........',
    '......oidcjlvmelllmlmleggco..oooo.........',
    '......ohphfvpcffvlthjhehhfo...............',
    '.....oeevvteeecpfthvjlehhhko..............',
    '....ochlmefjheoelmpvmbeefkno..............',
    '..oofhffffknno.olhvjeeheffo...............',
    '..offhhhfehhoo..othtdhhfhho...............',
    '..ohhhfedooo.....ooocffehho...............',
    '..ofjkheo...........odffhfo...............',
    '...okkno............ocefkkjo..............',
    '...okknnoo..........oefhknnkoo............',
    '...oksjsho..........offfhjhknjo...........',
    '....oooooo......ooooooooooooooo...........',
  ],
  [
    '..........................................',
    '.................oo.......................',
    '.................oo.......................',
    '................oo......ooo....o..........',
    '................ozo.....otto...oo.........',
    '................oxDo.oooggtlo..oo.........',
    '.................ozDogigegqqqooAo.........',
    '..............oo..ozABglggiqqlgxoo........',
    '.............oido.odtxxiulgqqqio.oo.......',
    '.............oidAoigdlfiqqgiegliozo.......',
    '..........o..oeexBdddggglqfevsfgezo.......',
    '.........ogoodgievBAAuiedfjxshpgeo........',
    '.........oglddeigdftAtqfpsxnvfkso.........',
    '.........odgffffdelccxifnfvxpppko.........',
    '.........ofhkjjhhefdddgdnnjhjxvpo.........',
    '.........okArkkkkhedddecfnkthvnto.........',
    '........ofmwurrnnkhddggegfhpjtseo.........',
    '........ohkuwwwwrjffdeggjkeknhkxo.........',
    '.......ohfhknuwrkhhheddecketdeexo.........',
    '......ohzkhffhhhffhnedccdjdelmejo.........',
    '.....ojrwukkmkfeddhskhedbfkdehdo..........',
    '...o.ojnuknAAnhddhhkkkkfedcdffco..........',
    '...oohhhhhyuAkddemnnksskhfhjccgo..........',
    '...omfhfhehrpfcefhnssssskkkneeo...........',
    '...onecfffccbcdehfhnnssnjknsdhjo..........',
    '...ohlhpephlbddefhjkkkkhfhjhdjhjo.........',
    '...ofhhpfpmlbdeehhksssrnkkhdefekmo........',
    '...ofjhjjhpjdbdffhknnkjhfnkdeefmho........',
    '...ojhhjfjpkfcpdeeepzAAAhfcdfeffho........',
    '....olfememhebcjvtddfzzexhbehhefeho.......',
    '.....oohhphmeffhmttjzmuulvcdfhfefjnoo.....',
    '.......ofhhhfhhhevezeuECqfbcddefdfkjho....',
    '........oehfjjhedjezeqEymfeabodeddfeeo....',
    '........odefhhkhdtefhqEulgbfo.oodbeehko...',
    '.........oehhhhhdvpemhllilafo...oacdho....',
    '.........odhfffdpiccdmdmlbalmo..ocdedo....',
    '.........oeccbcpthllcccdemdemo...oooo.....',
    '.........ofmlhpmcdhthvfhfmfhfeo...........',
    '.........ojvtvcdecjfpfvjtchjhho...........',
    '........ogttmcjhedlettxkmdehhko...........',
    '......ooeeeeejnkhoomfxxtdedefjo...........',
    '.....oedfhhfefkko..omhtlfhffhfo...........',
    '.....ohffffedooo...oooobehfhko............',
    '.....ofhhfdbo..........ocefhho............',
    '......ohkkho............oefhkho...........',
    '......ojnnkfo...........oefjnkkoo.........',
    '......ohnnnko..........oefhhkknnhoo.......',
    '.......ooooooooooooo.oooooooooooooo.......',
  ],
  [
    '..........................................',
    '....................oo....................',
    '....................oo....................',
    '...................oo......oo.....o.......',
    '...................oBo....ogqo....oo......',
    '...................oBo...obgqqoo..oo......',
    '....................oBoooqdgiqqloozo......',
    '.................oo.ovvBAhmgglqqmdxo......',
    '................olvoaabmBzlCggqqgegEo.....',
    '................omzmdggdpglqqglffqgFBo....',
    '.............o..ogfBdbcdgegmlgcvseifo.....',
    '............omooeggdxBBdygdfdnnvhnedo.....',
    '............olqdeegebdAzqqdmsssefkmo......',
    '............odefffedeidvglfjefvnnnfo......',
    '............ofhhhhffdgdegihkjlfnvfeo......',
    '............ojrkhkkkffddddcesmhjxhvo......',
    '...........ohmyrrwrnjfdddgdffhnhvno.......',
    '..........ofhmrrwyynhffbegejffppfjvo......',
    '.........ojkhhkmuyrkhfhdcedlkehcejpo......',
    '.........oCymhffhhfhfjkedbdcjffmjemo......',
    '........ojDBnkmnnfedfkskedcblfeefco.......',
    '......o.ojkkkrywnhcehhknjjedebdfdbo.......',
    '......oohfhhhywBkcdfknnnsnjfffhcdo........',
    '......omfffhfhrkcdefhkssssthjksfjko.......',
    '......okjemepedcdeeffhnssskhnrnejcho......',
    '......oefjpjpjjcdeffhkhknkhfhheefffo......',
    '......odhhnmmpjbdefhjkrpnnnnnfdeehjo......',
    '......ofjhlflpjbbeffhknjedcmrheheffho.....',
    '......oomfflfmjfccdfeevxzzzjxcehfeefjo.oo.',
    '........offhmjpehecvtpmAzggxvbdfhedfkhodeo',
    '.........oefjjmhhjhfepkhuwqivbodfeeehjhfdo',
    '..........offhfjkhedxfzmuAClvo.ooddegecfco',
    '...........oefhhhkhdxezlqyulvco..odecbdkdo',
    '............offhjhhhefxlqCqgtbjo..ohafkeo.',
    '............odffhfddeieliligbglo..ofibjo..',
    '............odddbgpvcibbgegdbdmmo..oooo...',
    '............ohjilhtlbjjgbeclcffhho........',
    '............ojljmvcdihphththehhfho........',
    '...........oeevtpefebpjthxhvdfhhko........',
    '...........ohpvdhhhfojjthpvdeefhno........',
    '.........ooedhhfknko.omhzhtdhfeffo........',
    '........oeehhfffhkoo..ophxcfhfhhfo........',
    '........ohfffeddoo.....ooocehehho.........',
    '........ohjhfdoo..........ocehhho.........',
    '........ofkkko.............offhkko........',
    '.........okknkoo..........odehhnnkoo......',
    '.........ohnkkho..........ofhhfjhhkho.....',
    '..........oooooo.oooo..ooooooooooooooo....',
  ],
];

const ORC_WALK = [
  [
    '..........................................',
    '...............oo.........................',
    '...............oo.........................',
    '..............oxo.....oo....oo............',
    '..............ozo....ogqo...oo............',
    '...............oBo.oodemtoo.oo............',
    '...............oABodldgglqiozo............',
    '............ooo.ozxBilggluqlcdo...........',
    '............odvoeegvzlulgqlliFzo..........',
    '...........oggAdegelfluylefgieBo..........',
    '.........o.odgeABefeggigdsppcho...........',
    '........oqodeifcABBqqdevxnhkndo...........',
    '........olmeegeegdxzqinvvsknso............',
    '........offhhffegidflfkejxnsho............',
    '........ojhkhjjhefdgednnkfkhmo............',
    '........oyunrrnkheddeefhssjhpo............',
    '.......ojuwrywsnhfddlihhpnjfpo............',
    '......ohhkmwwykkhhddggkvhjkhfo............',
    '.....oArhffhmmkjjkfddejseeeemo............',
    '.....oAwnkkhffefkrkfeddkfffefo............',
    '....ohkrnuwrkedhhknkhfdddgieo.............',
    '..oohhhhkwynhdeknnnsnjffcccho.............',
    '..olffffhrnhbdfjnssssnhjnrfjo.............',
    '..ojhhfmfhfcddghhnsssnknskfho.............',
    '..ofjktkpmbdeefhkknnnjhjjeffo.............',
    '...ofjtjmhmdefhjksvvsrmnjdehjo............',
    '..odljhjmjpddeffknffzeppefhhjo............',
    '..ojjfjfjljcedeexvxjjhljehehho............',
    '...oofejjmhhefvmdfxAqgjpdhhffjo...........',
    '.....offmkhfhjjhhzjuwufbcefffkno..........',
    '......ofjhjjkfhlfAlqCuibcoeeehkfo.........',
    '.......oefhkkjfefxlqCyiao.oddefdo.........',
    '........ohhkhhexhfhmqqfaeo.obbdhmo........',
    '........oehfhddcafhihlebjlo.ocdho.........',
    '........odedcttdiicctdlblmo.ooooo.........',
    '.......offvhhvdfjtftjvhdfdmo..............',
    '.......ofhkvjcddlpfpjvmdjhdo..............',
    '.......ojvvdjhfcphvjxhpehhho..............',
    '......odeehhkkhohmjmktcehhno..............',
    '....ooefhhhhnno.omjvjmdeefjo..............',
    '....ofhhhffeho...ovfvdfhfhho..............',
    '....ohhfeoooo.....ooocfffhfo..............',
    '....ohkko............odfhho...............',
    '....ohknko...........odfhkko..............',
    '....ofnnnho..........oefhkkkooo...........',
    '.....oooooo..........ofhfhhkkho...........',
    '.....................oooooooooo...........',
    '..........................................',
  ],
  [
    '..........................................',
    '..................o.......................',
    '.................oo.......................',
    '................oAo.....ooo...oo..........',
    '................oAo.....otqo..oAo.........',
    '.................oDo.ooogiqmo.oBo.........',
    '.................ozBodiigilqlodzo.........',
    '..............ooo.odzAfiggiuwmelo.........',
    '..............oexoeeezxluwgqmmieFo........',
    '.............oilzeegdigiqlggfellAo........',
    '...........o.oefeADedeggggedvpcieo........',
    '..........omoddifeeBBuqedpvnpjtho.........',
    '..........ollddgeegdvxmqnsvxsnspo.........',
    '..........offhhfffgidflekefpvxjfo.........',
    '..........olmkkjkhfgdegdkpjhjxhmo.........',
    '..........orwrnnnkhdddechjpskxko..........',
    '.........ohwurwwrnhfddlgjjhnjeno..........',
    '........offknwuwrkjhddegnshjmpjo..........',
    '.......oAkhhhkkkkjhkfddedxfhppvo..........',
    '......orwwkjkhhfffjrkfedchfjegho..........',
    '......okrrnuwrkedhhnrnhededfigo...........',
    '....oojkkhnwwkjdeknnnvnhfeededo...........',
    '....odfhffjrmhcefhnsvssrjknmfo............',
    '....otfdjfhefddefhknssskhnsnfo............',
    '....omjfmeffbdefhkkkkkkjhkneho............',
    '....ohhmtlfjddffhkknsvsnnnjdhho...........',
    '....oehlpmemcddffhjfxdzxfpdfhko...........',
    '....ohfmjmcjbdgedeeftAzxhfdhhjko..........',
    '.....ojpjjjjdfgihxxfzllqlvdhhhko..........',
    '.....ojjmhlfdgmmffhefqzuqxcfhhhno.........',
    '......ojjhmjddhjeptzfqywqvbdfffnno........',
    '......ojffkkkdeiepffhqyCivbddeehkho.......',
    '.......ofhjkkfdeexphmlmlhdfdbddffeo.......',
    '.......ohjknjdttmdedfmjgebgfhbbeeho.......',
    '.......ofhkkkedptbihfeddhacllddeeho.......',
    '........odfeddtvldethvxvfbfdjooodo........',
    '.........occpvjdfemmtvvvpchho...o.........',
    '.........ogmmmfhhfgftexmjfhhjo............',
    '........occdehkkhfophvkvdfhkko............',
    '......ooffhhhfkkjo.opvvhefffho............',
    '......ohhhhhhehjo..omptdhhfho.............',
    '......ofjhfeoooo....ooodffhko.............',
    '......ofkkho...........oefhjo.............',
    '.......okkno...........odghkjo............',
    '.......okknno..........oeehknnoo..........',
    '........ooooo..........ofgfjkkkjo.........',
    '.......................oooooooooo.........',
    '..........................................',
  ],
  [
    '..........................................',
    '...................oo.....................',
    '..................oo......o...............',
    '..................oo.....oqo....oo........',
    '..................oAo....omqo...oo........',
    '..................oABooooggtqoo.oo........',
    '...................oBBBelegilulozo........',
    '................oo..okBzeigivxlidgo.......',
    '...............olxooeepxlqqitmlqlFo.......',
    '...............oiiAcggdlgmuAiggqlfBo......',
    '............oo.oeeiABefiggledtpmlmo.......',
    '............oqoegiddBDAuieptsnhmheo.......',
    '............omgeefdgfevmiisvvnkpto........',
    '............ofhjjffdgdeiljjfjxnkfo........',
    '............oknkkjkhdddgghnkjhnkvo........',
    '...........ohrwnrrnkfdddddhxvjkkno........',
    '..........oejrrwAwrkffdgiejfhnfjho........',
    '.........omjhkruyrnkhhdeeesfkhpkjo........',
    '.........oAukffhmjjfknedddnfhhtejo........',
    '........omuwkkkkhedfnsheddftfjheho........',
    '......o.okrkrwznfcejhknkhfdddfjdo.........',
    '.....omojhhhrBwhddfknnnvnhfgeddo..........',
    '......ofehfhjkkedefhnssssnknnlgo..........',
    '......ojjjfhfeddeehhhnssskknndho..........',
    '......ofjmfjhdcdefhknnnnnjjhhdfjo.........',
    '......ofhpjmfpddeefknsvstmpmcehko.........',
    '.....ohhfmjmfpcdceghflxzzxehdhhkno........',
    '......ohjhfmmpdeivdddthBAxlbgjjkko........',
    '.......ojjpkmmeffhfvehzuuqjifhhhjjo.......',
    '........olmkmjdfmmptfzhwuugbcefffjjo......',
    '........ojfjjhefjmepfxtuCwidgodeejho......',
    '.........oefjkkeppedevpuCuhbo.oddhffo.....',
    '.........oehjkhfifeppfpmllhco..ocefho.....',
    '.........ohhkkfbpkvmcdjmtlcejo.oddfo......',
    '.........ofhkhfemtpdmmhjidldjo.ooeeo......',
    '..........oofcdtmddeettxvthdedo..oo.......',
    '............ogppdhfehmhjmhmcjfo...........',
    '...........ocfdhkkhooltvmvefjno...........',
    '..........oefffkkko..omjtjcfhno...........',
    '........ooehjhhhkho...oppeeffho...........',
    '........ofhhhhfeoo....oolehfjho...........',
    '.........ohkfeoo........oehfhho...........',
    '.........okkho...........offhho...........',
    '.........ohkko...........oefhkjo..........',
    '.........ofkkko..........oefknnnoo........',
    '..........ooooo..........ofhhhjkkfo.......',
    '.........................ooooooooo........',
    '..........................................',
  ],
];

const ORC_ATTACK = [
  [
    '.................oo.......................',
    '................oo......o.................',
    '................oo.....olo....o...........',
    '................oBo....ogto...oo..........',
    '................oBBooooditqoo.oo..........',
    '.................oDBxildglmmmozo..........',
    '..............oo..ojBAligituicdBo.........',
    '.............oqzooddkxlqqlqqllgAho........',
    '.............omeBdgggiglmieiddiABo........',
    '..........o..oedBDddegeilxcxvnleo.........',
    '.........oeoodgiezBBAqgdetxvhvndo.........',
    '.........oeledegegghvtqfpvxvksvo..........',
    '.........odeffffeglddiljefkxxxho..........',
    '.........oejkjhhhegddgghseehxnfo..........',
    '.........onynnnnkhedddddjssnxkno..........',
    '........ohyyrvsrnjfedggejhnkhheo..........',
    '.......oefkrryuvkjhebggepfnnkmpo..........',
    '......odhfhkkrrnkhjfddedkejfhcvo..........',
    '......oCwrhfffhffhnkedcbffdptfeo..........',
    '.....ohrwrknmkfdefmsnfeccecfhfo...........',
    '...o.oknkmwwrkedgjknsnkfdbbigdo...........',
    '...oohhjhhrurhcdfmssssrhfhkkeio...........',
    '...omefhhejmhcdefhnsspsnknrpko............',
    '...ohmhvhpjebddfhhjknpnhjnnejho...........',
    '....ohktfmlmbdefhknnkmkjkhfehcfo..........',
    '....ofhpeljjbdffhkkprrtmppdedejo..........',
    '...oelhjfjphcbdeffhmxvvfjldfehjjo.........',
    '....ohffhjplafmpcectlAvxfadhfehho.........',
    '.....offjjmhgceejhdfluuhmadhhfefhoo.......',
    '......offmjhfkhfhhdzqEwmfbdefhfekkho......',
    '.......oehjhhjhfetezqEyqjcaodeedfjfo......',
    '........oehhhkhddfexmCqmhco.ooddchcjo.....',
    '.........oehkhkhexfplllmgceo..odbedno.....',
    '.........oehhheefceelhhjdagmo..oadffo.....',
    '.........oeedcdtpdlchbbciaepo..odcoo......',
    '........oedplmtvchhvgjjzjejdo...oo........',
    '........oljhhptccfjhklphcfkhfo............',
    '........ofevvefeedptmfxjdfhhko............',
    '.......odcccchkhecjfhjteeefhko............',
    '.....ooeehhhhnnkfolmvvkdffeffo............',
    '.....oehhhhhfknko.omkhtehhfho.............',
    '.....ofhhhfedooo...oooodfffho.............',
    '.....ohhfeeoo..........odhhho.............',
    '.....ohkkho............oefhkko............',
    '.....ohnnko...........odffhnnkooo.........',
    '......onnnjoo.........oehhehhhkfmo........',
    '......oooobmo..........oooooooooo.........',
    '..........oo..............................',
  ],
  [
    '..........................................',
    '..........................................',
    '..............o...........................',
    '.............ozo..oo..oo..o...............',
    '..............oo..omoogmooo...............',
    '..............oBoodgqigfqivo..............',
    '...............oxBzeiqgiqmgvo.............',
    '............o...opxgimuimyixo.............',
    '............ooo..oiggiqggpedo.............',
    '............olgooeluggigxtteo....oo.......',
    '............ogifxdelqepxxnteo..oojko......',
    '..........oodgghffelgejfsnpeboohhnnno.....',
    '..........omdfhhhffgeemhmptejpjjjhkko.....',
    '..........oiifhhjhfdgdmnjfjjmkjjhhhjo.....',
    '..........odhhfhhefegdeffhmjnjjlhfeo......',
    '..........odfhhkuuifnwyrkmkpmmehooo.......',
    '.........oeehhhkryyknwwpjhkpkhho..........',
    '.........oefhfhkkrmkkrnkffeejho...........',
    '..........ohhfhkmuwjzyynjfcgfo............',
    '..........ohhefhjhhjrwyhfdeoo.............',
    '..........ohgeffhheehkfcdbo...............',
    '..........oeheeeeedccnnsvo................',
    '...........ohfedbjjkmnnso.................',
    '...........offefmknnnnkko.................',
    '...........odehhjksssssho.................',
    '...........odehkknnnsnsmdo................',
    '...........oeefhkkmfhhhddjooo.............',
    '...........oflxehfvjmmjddfcjo.............',
    '...........ofpnjkdxuugledcdejo............',
    '..........oefppmmezqyyqbddffho............',
    '..........odfjfjmexmCulbdgeffo............',
    '..........ofeedfhfxmwqibjcgfo.............',
    '.........omjpfhmgetiiiffllco..............',
    '.........ohkjjvphgflllecjjo...............',
    '.........ohpmtmmefmeediceelo..............',
    '........ofjjvvpcehvpvvtcfhho..............',
    '........oejjvhfecmjtvjmdfkjho.............',
    '........oedekkjfohjjjhbdfjjko.............',
    '.......ofeefjkho.otjvmdefhkno.............',
    '.......ohhffhjo..omlmdefffhjo.............',
    '......ohkhfeeo....oooodhjhhfo.............',
    '.....ohhkheoo.........offfjo..............',
    '.....ohkheo...........odfhfo..............',
    '.....ohkho............odfhko..............',
    '.....ohkjo............odfkkkoo............',
    '.....oknnko...........offhhkkjo...........',
    '.....ooooomo...........oooooooo...........',
    '..........o...............................',
  ],
];

// ----------------------------------------------------------------- coin 7x7
const COIN_PAL = { o: '#3a2406', y: '#ffc633', L: '#fff0a8', d: '#c98a14' };
const COIN_A = [
  '..ooo..',
  '.oLyyo.',
  'oLyddyo',
  'oyydyyo',
  'oyddyyo',
  '.oyyyo.',
  '..ooo..',
];

// ----------------------------------------------------------------- heart 7x7
// A floating heart pickup: same size, anchor and hover as the coin; the knight's red ramp (STYLE_GUIDELINES).
const HEART_PAL = { o: '#2b0508', R: '#d11920', d: '#750b0f', L: '#ff9a8f' };
const HEART_A = [
  '.oo.oo.',
  'oLRoRRo',
  'oLRRRRo',
  'oRRRRdo',
  '.oRRdo.',
  '..odo..',
  '...o...',
];

// Raw art data (DOM-free) so it can be validated / previewed in node.
export const ART = {
  knight: { palette: KNIGHT_PAL, frames: [KNIGHT_A, KNIGHT_B], anchorX: 9, anchorY: 23 },
  ghost: { palette: GHOST_PAL, frames: [GHOST_A, GHOST_B], anchorX: 9, anchorY: 19 },
  troll: { palette: ORC_PAL, frames: ORC_IDLE, walk: ORC_WALK, attack: ORC_ATTACK, anchorX: 17, anchorY: 47 },
  chest: { palette: CHEST_PAL, frames: [CHEST_A], anchorX: 6, anchorY: 9 },
  coin: { palette: COIN_PAL, frames: [COIN_A], anchorX: 3, anchorY: 5 },
  heart: { palette: HEART_PAL, frames: [HEART_A], anchorX: 3, anchorY: 5 },
};

function rasterise(grid, palette) {
  const h = grid.length;
  const w = grid[0].length;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < h; y++) {
    const row = grid[y];
    for (let x = 0; x < w; x++) {
      const c = row[x];
      if (c === '.') continue;
      ctx.fillStyle = palette[c];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

function build(def) {
  const frames = def.frames.map((grid) => ({
    canvas: rasterise(grid, def.palette),
    w: grid[0].length,
    h: grid.length,
    anchorX: def.anchorX,
    anchorY: def.anchorY,
  }));
  const main = { ...frames[0] };
  if (frames.length > 1) main.frames = frames;
  if (def.walk) main.walk = def.walk.map((grid) => ({ ...frames[0], canvas: rasterise(grid, def.palette) }));
  if (def.attack) main.attack = def.attack.map((grid) => ({ ...frames[0], canvas: rasterise(grid, def.palette) }));
  return main;
}

export function buildSprites() {
  return {
    knight: build(ART.knight),
    ghost: build(ART.ghost),
    troll: build(ART.troll),
    chest: build(ART.chest),
    coin: build(ART.coin),
    heart: build(ART.heart),
  };
}
