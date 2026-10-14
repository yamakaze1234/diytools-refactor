/** 编辑框由 React 持有，保留工作台原生事件绑定；重绘不打断中文输入和光标。 */
import {useLayoutEffect,useRef,type InputHTMLAttributes,type SelectHTMLAttributes,type TextareaHTMLAttributes} from 'react';
type Value = string | number | null | undefined;
export function Input({value,checked,...props}:Omit<InputHTMLAttributes<HTMLInputElement>,'value'> & {value?:Value}) {
 const ref=useRef<HTMLInputElement>(null);
 useLayoutEffect(()=>{const node=ref.current;if(!node)return;if(checked!==undefined)node.checked=checked;if(node.ownerDocument.activeElement!==node&&value!==undefined&&node.value!==String(value??''))node.value=String(value??'');});
 return <input {...props} ref={ref} defaultValue={value??''} defaultChecked={checked}/>;
}
export function Textarea({value,...props}:Omit<TextareaHTMLAttributes<HTMLTextAreaElement>,'value'> & {value?:Value}) {
 const ref=useRef<HTMLTextAreaElement>(null);
 useLayoutEffect(()=>{const node=ref.current;if(node&&node.ownerDocument.activeElement!==node&&node.value!==String(value??''))node.value=String(value??'');});
 return <textarea {...props} ref={ref} defaultValue={value??''}/>;
}
export function Select({value,...props}:Omit<SelectHTMLAttributes<HTMLSelectElement>,'value'> & {value?:Value}) {
 const ref=useRef<HTMLSelectElement>(null);
 useLayoutEffect(()=>{const node=ref.current;if(node&&node.ownerDocument.activeElement!==node&&node.value!==String(value??''))node.value=String(value??'');});
 return <select {...props} ref={ref} defaultValue={value??''}/>;
}
// 旧业务字段保持开放形状；投影模型不会复制或改变保存协议。
export type Row = Record<string,any>;
