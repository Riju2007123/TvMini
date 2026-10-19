/**
 * Bundled by jsDelivr using Rollup v4.62.2 and esbuild v0.28.1.
 * Original file: /npm/ieee754@1.2.1/index.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
var v={};var n;function I(){return n||(n=1,v.read=function(_,a,f,p,e){var t,r,M=e*8-p-1,w=(1<<M)-1,s=w>>1,i=-7,o=f?e-1:0,d=f?-1:1,h=_[a+o];for(o+=d,t=h&(1<<-i)-1,h>>=-i,i+=M;i>0;t=t*256+_[a+o],o+=d,i-=8);for(r=t&(1<<-i)-1,t>>=-i,i+=p;i>0;r=r*256+_[a+o],o+=d,i-=8);if(t===0)t=1-s;else{if(t===w)return r?NaN:(h?-1:1)*(1/0);r=r+Math.pow(2,p),t=t-s}return(h?-1:1)*r*Math.pow(2,t-p)},v.write=function(_,a,f,p,e,t){var r,M,w,s=t*8-e-1,i=(1<<s)-1,o=i>>1,d=e===23?Math.pow(2,-24)-Math.pow(2,-77):0,h=p?0:t-1,N=p?1:-1,c=a<0||a===0&&1/a<0?1:0;for(a=Math.abs(a),isNaN(a)||a===1/0?(M=isNaN(a)?1:0,r=i):(r=Math.floor(Math.log(a)/Math.LN2),a*(w=Math.pow(2,-r))<1&&(r--,w*=2),r+o>=1?a+=d/w:a+=d*Math.pow(2,1-o),a*w>=2&&(r++,w/=2),r+o>=i?(M=0,r=i):r+o>=1?(M=(a*w-1)*Math.pow(2,e),r=r+o):(M=a*Math.pow(2,o-1)*Math.pow(2,e),r=0));e>=8;_[f+h]=M&255,h+=N,M/=256,e-=8);for(r=r<<e|M,s+=e;s>0;_[f+h]=r&255,h+=N,r/=256,s-=8);_[f+h-N]|=c*128}),v}var x=I(),q=x.read,g=x.write;export{x as default,q as read,g as write};
//# sourceMappingURL=/sm/d58ca1d568408ee50665e9a91a367efc824d1a46677d42b1cfb0058011cfedc1.map