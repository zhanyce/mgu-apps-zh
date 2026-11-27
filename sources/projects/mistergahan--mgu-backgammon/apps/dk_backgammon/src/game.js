'use strict';
const E = typeof module !== 'undefined' ? require('./engine.js') : window.Backgammon;
function Game(saved) {
    this.state = saved && E.valid(saved.state) ? saved.state : E.initial();
    this.mode = saved && saved.mode === 'local' ? 'local' : 'computer';
    this.history = []; this.confirm = false; this.note = "";
}
Game.prototype.snapshot = function() { return {schema:1,state:this.state,mode:this.mode}; };
Game.prototype.status = function() {
    const s=this.state, who = s.player===0 ? '白方' : '黑方';
    if(s.winner!==null) return (s.winner===0?'白方':'黑方')+'获胜 · '+s.pointsWon+' 分';
    if(s.opening && this.note) return this.note;
    if(s.opening) return '开局双方各掷一枚骰子，点数相同则重掷。';
    return (s.variant==='long'?'长局 · ':'短局 · ')+who+' · '+(s.roll.length ? '点数 '+s.roll.join(' : ')+' · 剩余 '+(s.dice.join(', ')||'—') : '请掷骰子');
};
Game.prototype.actions = function() {
    const s=this.state;
    if(this.confirm) return [{label:'取消',op:'cancel'}].concat(['short','long'].reduce((all,variant)=>all.concat(['computer','local'].map(mode=>({label:(variant==='long'?'长局':'短局')+' · '+(mode==='computer'?'人机对局':'双人对局'),op:'new',mode,variant}))),[]));
    const a=[];
    if(s.winner===null) {
        if(s.opening || !s.roll.length) a.push({label:s.opening?'开局掷骰':'掷骰子',op:'roll'});
        else {
            const moves=E.legal(s);
            if(this.mode==='computer' && s.player===1 && moves.length) a.push({label:'电脑走棋',op:'ai'});
            else moves.forEach(m=>a.push({label:(m.from===-1?'中栏':m.from+1)+' → '+(m.to===24?'移出':m.to+1)+'   [ '+m.die+' ]',op:'move',move:m}));
            if(!moves.length) a.push({label:s.dice.length?'无合法走法 · 交给对手':'结束回合',op:'finish'});
        }
        if(this.history.length) a.push({label:'悔棋',op:'undo'});
    }
    a.push({label:'新开一局…',op:'confirm'}); return a;
};
Game.prototype.act = function(a,die) {
    if(!this.actions().some(x=>JSON.stringify(x)===JSON.stringify(a))) throw new Error('当前操作已失效');
    if(a.op==='confirm') this.confirm=true;
    else if(a.op==='cancel') this.confirm=false;
    else if(a.op==='new') {this.state=E.initial(a.variant);this.mode=a.mode;this.history=[];this.confirm=false;this.note='';}
    else if(a.op==='roll') {const rolled=[];this.state=E.roll(this.state,()=>{const d=die();rolled.push(d);return d;});this.note=this.state.opening?'点数 '+rolled.join(' : ')+' · 平手，请重掷':'';this.history=[];}
    else if(a.op==='finish') {this.state=E.finish(this.state);this.history=[];}
    else if(a.op==='undo') this.state=this.history.pop();
    else {const m=a.op==='ai'?E.ai(this.state):a.move;this.history.push(E.copy(this.state));this.state=E.move(this.state,m);}
};
if(typeof module !== 'undefined') module.exports=Game; else window.Game=Game;
