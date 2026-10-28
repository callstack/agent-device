/**
 * Page script that selects the content of the focused editable element. `fill` runs it after the
 * click instead of pressing a select-all shortcut, so a click that misses every editable element
 * cannot send that shortcut to the host menu (#3987).
 */
export const SELECT_FOCUSED_CONTENT_EVAL_SCRIPT = `(()=>{
let el=document.activeElement;
while(el&&el.shadowRoot&&el.shadowRoot.activeElement)el=el.shadowRoot.activeElement;
if(!el)return false;
if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement){el.select();return true}
if(el.isContentEditable){
const range=document.createRange();
range.selectNodeContents(el);
const selection=window.getSelection();
selection.removeAllRanges();
selection.addRange(range);
return true}
return false})()`;
