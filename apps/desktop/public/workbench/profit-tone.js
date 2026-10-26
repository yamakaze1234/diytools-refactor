/** 按界面显示的人民币分值区分盈利、小额亏损和超过 100 元的亏损。 */
export function profitTone(value){
 if(value==null||!Number.isFinite(Number(value)))return 'unknown';
 const cents=Math.round(Number(value)*100);
 return cents>0?'positive':cents < -10000?'loss':cents<0?'negative':'neutral';
}
