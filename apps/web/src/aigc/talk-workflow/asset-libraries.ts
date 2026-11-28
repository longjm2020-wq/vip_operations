/**
 * 场景库（40 种精选风格关键词场景）、道具库与服饰库剧情智能推荐引擎
 */

export type SceneStylePreset = {
  id: string;
  category: string;
  name: string;
  keywords: string;
};

/** 40 种风格的关键词场景（覆盖商业棚拍、都市街拍、自然户外、古风武侠、科幻赛博、居家生活、复古电影、国潮艺术） */
export const sceneStylePresets40: readonly SceneStylePreset[] = [
  // 一、商业棚拍与极简时尚（5）
  { id: "s01", category: "商业棚拍", name: "极简纯白影棚", keywords: "极简纯白无影墙，柔光箱漫反射，高级时装棚拍质感" },
  { id: "s02", category: "商业棚拍", name: "高级冷灰水泥棚", keywords: "冷灰微水泥背景，硬朗轮廓光，杂志大片影棚" },
  { id: "s03", category: "商业棚拍", name: "暖米色侘寂画室", keywords: "暖米色肌理漆墙面，自然百叶窗斜阳，侘寂风时尚影棚" },
  { id: "s04", category: "商业棚拍", name: "法式石膏线展厅", keywords: "白色法式雕花石膏线墙面，复古水晶吊灯，轻奢服装展厅" },
  { id: "s05", category: "商业棚拍", name: "T台秀场聚光灯", keywords: "暗调时装周T台，顶部追光束与两侧虚化观众席，高级秀场" },

  // 二、都市通勤与街拍（6）
  { id: "s06", category: "都市街拍", name: "CBD 玻璃幕墙写字楼", keywords: "现代CBD落地玻璃幕墙大堂，自然都市通勤光影" },
  { id: "s07", category: "都市街拍", name: "法式梧桐林荫街角", keywords: "上海安福路梧桐树荫街角，斑驳阳光，松弛感都市街拍" },
  { id: "s08", category: "都市街拍", name: "复古红砖艺术街区", keywords: "红砖工业风文创街区，铁艺楼梯，潮流街头穿搭背景" },
  { id: "s09", category: "都市街拍", name: "高级买手店陈列区", keywords: "设计师品牌买手店，金属挂衣架与暖光射灯，质感陈列" },
  { id: "s10", category: "都市街拍", name: "落地窗高空咖啡馆", keywords: "城市高层落地窗咖啡厅，手冲吧台与窗外天际线" },
  { id: "s11", category: "都市街拍", name: "霓虹都市夜色街头", keywords: "雨后城市霓虹夜景街道，地面倒影与电影感冷暖光" },

  // 三、居家生活与温柔氛围（5）
  { id: "s12", category: "居家生活", name: "奶油风阳光客厅", keywords: "奶油风极简客厅，米白布艺沙发，午后窗纱柔光" },
  { id: "s13", category: "居家生活", name: "法式复古衣帽间", keywords: "定制木质衣帽间，全身落地试衣镜，温馨日常试穿氛围" },
  { id: "s14", category: "居家生活", name: "原木书房阅读角", keywords: "原木书架与台灯暖光，文艺静谧居家读书氛围" },
  { id: "s15", category: "居家生活", name: "清晨阳光露台阳台", keywords: "绿植花卉阳台露台，清晨柔和金色侧逆光" },
  { id: "s16", category: "居家生活", name: "轻奢酒店落地窗套房", keywords: "五星级酒店全景落地窗套房，优雅旅拍质感" },

  // 四、自然户外与度假（6）
  { id: "s17", category: "自然度假", name: "海滨日落金色沙滩", keywords: "海边日落黄金时刻，细腻沙滩与海风微拂，度假氛围" },
  { id: "s18", category: "自然度假", name: "南法庄园薰衣草花海", keywords: "普罗旺斯风格田园花海与石砌拱门，浪漫法式度假" },
  { id: "s19", category: "自然度假", name: "森系晨雾松林小径", keywords: "清晨薄雾森林木栈道，丁达尔光束穿过松林" },
  { id: "s20", category: "自然度假", name: "北欧雪山木屋冬景", keywords: "皑皑白雪山脉与暖光木屋露台，冬装大衣羽绒服外景" },
  { id: "s21", category: "自然度假", name: "秋日银杏落叶公园", keywords: "金黄银杏大道与落叶长椅，秋冬大衣毛衣氛围感" },
  { id: "s22", category: "自然度假", name: "西部荒漠公路日落", keywords: "苍茫戈壁公路与落日余晖，美拉德风酷飒外拍" },

  // 五、古风武侠与国潮（6）
  { id: "s23", category: "古风武侠", name: "竹林深处武侠秘境", keywords: "苍翠幽深竹林，轻雾缭绕与竹叶飘落，经典武侠江湖意境" },
  { id: "s24", category: "古风武侠", name: "大漠孤烟边塞客栈", keywords: "黄沙漫天边塞古客栈，残阳如血与木质酒旗，硬核武侠" },
  { id: "s25", category: "古风武侠", name: "烟雨江南水乡古桥", keywords: "青石板小巷、乌篷船与烟雨拱桥，新中式温婉意境" },
  { id: "s26", category: "古风武侠", name: "朱红宫墙飞檐古建", keywords: "故宫红墙琉璃瓦与松柏光影，大气端庄国风大片" },
  { id: "s27", category: "古风武侠", name: "云海仙山悬崖古亭", keywords: "云雾翻涌的绝壁古亭，仙侠飘逸逆光剪影" },
  { id: "s28", category: "古风武侠", name: "灯火阑珊古风夜市", keywords: "盛唐长安灯笼长街，暖黄火树银花，繁华古风夜色" },

  // 六、科幻赛博与未来（4）
  { id: "s29", category: "科幻未来", name: "赛博朋克霓虹雨巷", keywords: "高饱和青紫霓虹全息招牌，赛博朋克未来潮牌街区" },
  { id: "s30", category: "科幻未来", name: "极简银白太空舱", keywords: "流线型纯白与拉丝金属星舰舱室，冷光科技感" },
  { id: "s31", category: "科幻未来", name: "数据矩阵全息实验室", keywords: "深邃暗黑空间与悬浮蓝光全息投影，未来感科技片场" },
  { id: "s32", category: "科幻未来", name: "废土工业机械遗址", keywords: "锈蚀钢铁巨构与漫天尘雾，末世机能风硬核片场" },

  // 七、复古电影与文艺（4）
  { id: "s33", category: "复古电影", name: "港风胶片霓虹茶餐厅", keywords: "王家卫式90年代港风茶餐厅，绿皮卡座与暖色胶片颗粒" },
  { id: "s34", category: "复古电影", name: "胶片感复古火车站台", keywords: "老式绿皮火车与木质月台，怀旧电影叙事感" },
  { id: "s35", category: "复古电影", name: "黑胶唱片复古酒吧", keywords: "昏暗琥珀色灯光、黑胶唱片墙与爵士氛围" },
  { id: "s36", category: "复古电影", name: "欧式古典图书馆", keywords: "挑高胡桃木书墙与拱形彩窗，英伦学院复古风" },

  // 八、运动校园与创意艺术（4）
  { id: "s37", category: "运动校园", name: "阳光塑胶操场看台", keywords: "蓝天白云下的校园跑道与阶梯看台，青春活力运动风" },
  { id: "s38", category: "运动校园", name: "极简普拉提瑜伽馆", keywords: "大面积落地镜与自然采光木地板，健康塑形运动空间" },
  { id: "s39", category: "运动校园", name: "当代极简美术馆", keywords: "几何建筑光影与纯白艺术展墙，先锋设计师画廊" },
  { id: "s40", category: "运动校园", name: "网球场红土户外馆", keywords: "经典红土/墨绿网球场，阳光老钱风运动穿搭" },
] as const;

export type StoryRecommendationGroup = {
  genre: string;
  matchRegex: RegExp;
  props: string[];
  garments: string[];
};

const storyRecommendationRules: readonly StoryRecommendationGroup[] = [
  {
    genre: "武侠江湖",
    matchRegex: /武侠|江湖|侠客|古装打斗|剑客|刀客|门派|大侠|边塞|竹林/i,
    props: ["长剑", "佩刀", "齐眉棍", "铁棒", "战斧", "酒葫芦", "折扇", "令牌"],
    garments: ["玄铁铠甲", "粗麻布衣", "侠客紧身劲装", "斗笠披风", "素色门派长袍", "锦衣卫飞鱼服"],
  },
  {
    genre: "古风仙侠 / 新中式",
    matchRegex: /仙侠|古风|汉服|新中式|国风|江南|长安|宫廷|修仙/i,
    props: ["古琴", "油纸伞", "玉佩", "宫灯灯笼", "书画卷轴", "团扇", "拂尘"],
    garments: ["织金马面裙", "新中式盘扣上衣", "广袖仙气纱袍", "刺绣披帛", "齐胸襦裙", "宋制褙子"],
  },
  {
    genre: "都市通勤 / 时尚带货",
    matchRegex: /通勤|职场|显瘦|穿搭|外套|衬衫|西装|大衣|连衣裙|小红书|抖音|带货|白领/i,
    props: ["手提托特包", "热美式咖啡杯", "实木衣架", "全身试衣镜", "墨镜", "真丝丝巾", "笔记本电脑"],
    garments: ["垂感西装外套", "高腰阔腿西裤", "经典双排扣风衣", "真丝醋酸衬衫", "收腰针织连衣裙", "羊绒大衣"],
  },
  {
    genre: "科幻赛博 / 机能潮牌",
    matchRegex: /科幻|赛博|未来|机能|末世|废土|机甲|太空|潮牌|街头/i,
    props: ["全息数据终端", "霓虹护目镜", "战术腰包", "发光能量棒", "头戴式金属耳机", "滑板"],
    garments: ["防水机能冲锋衣", "多袋工装裤", "反光银色太空服", "暗黑战术马甲", "廓形重磅卫衣", "皮质机车夹克"],
  },
  {
    genre: "法式浪漫 / 户外度假",
    matchRegex: /法式|度假|海边|沙滩|森系|田园|露营|旅行|约会|浪漫/i,
    props: ["法式草编包", "宽檐草帽", "胶片相机", "复古手捧花", "野餐藤篮", "防晒墨镜"],
    garments: ["法式碎花茶歇裙", "透气亚麻衬衫", "镂空针织开衫", "白色棉麻长裙", "轻薄防晒罩衫", "度假吊带裙"],
  },
  {
    genre: "运动健身 / 校园青春",
    matchRegex: /运动|健身|瑜伽|网球|校园|青春|学院|跑步|户外/i,
    props: ["网球拍", "运动水壶", "瑜伽垫", "帆布双肩包", "无线蓝牙耳机", "棒球帽"],
    garments: ["裸感瑜伽服套装", "老钱风网球百褶裙", "学院风针织背心", "速干运动夹克", "复古棒球服", "条纹Polo衫"],
  },
];

/**
 * 根据剧情描述 / 工作流标题 / 拆解内容智能匹配推荐道具与服饰
 */
export function recommendPropsAndGarmentsByStory(storyText: string): {
  matchedGenre: string;
  props: string[];
  garments: string[];
  allGenres: readonly StoryRecommendationGroup[];
} {
  const clean = storyText.trim();
  const matched =
    storyRecommendationRules.find((rule) => rule.matchRegex.test(clean)) ||
    storyRecommendationRules[2]; // 默认回退到都市通勤/时尚带货
  return {
    matchedGenre: matched.genre,
    props: matched.props,
    garments: matched.garments,
    allGenres: storyRecommendationRules,
  };
}
