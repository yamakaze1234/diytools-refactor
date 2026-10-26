/** 编辑框由 React 持有，保留工作台原生事件绑定；重绘不打断中文输入和光标。 */
import {useLayoutEffect,useRef,type ComponentProps,type ButtonHTMLAttributes,type InputHTMLAttributes,type SelectHTMLAttributes,type TextareaHTMLAttributes} from 'react';
import {Button as ReuiButton} from '../components/ui/button';
import {Input as ReuiInput} from '../components/ui/input';
import {Textarea as ReuiTextarea} from '../components/ui/textarea';
import {NativeSelect} from '../components/ui/native-select';

/** 原业务通过 DOM 属性控制禁用状态；保留原生事件和 submit 默认值，避免组件内部旧 disabled 闭包阻断重新启用。 */
export function Button({type='submit',variant,className,...props}:ButtonHTMLAttributes<HTMLButtonElement> & {variant?:ComponentProps<typeof ReuiButton>['variant']}) {
 const resolvedVariant=variant??(className?.split(/\s+/).includes('primary')?'default':className?.split(/\s+/).includes('danger')?'destructive':'outline');
 return <ReuiButton {...props} type={type} className={className} variant={resolvedVariant} render={renderProps=><button {...renderProps} onClick={props.onClick} onMouseDown={props.onMouseDown} onKeyDown={props.onKeyDown} onKeyUp={props.onKeyUp} onPointerDown={props.onPointerDown}/>}/>;
}

type Value = string | number | null | undefined;
export function Input({value,checked,...props}:Omit<InputHTMLAttributes<HTMLInputElement>,'value'> & {value?:Value}) {
 const ref=useRef<HTMLInputElement>(null);
 useLayoutEffect(()=>{const node=ref.current;if(!node)return;if(checked!==undefined)node.checked=checked;if(node.ownerDocument.activeElement!==node&&value!==undefined&&node.value!==String(value??''))node.value=String(value??'');});
 // 复选框及颜色等原生专用控件不套用文本输入组件，保留 checked 和浏览器原生交互。
 const Component=['checkbox','radio','color','range','file','hidden'].includes(props.type||'')?'input':ReuiInput;
 return <Component {...props} ref={ref} defaultValue={value??''} defaultChecked={checked}/>;
}
export function Textarea({value,...props}:Omit<TextareaHTMLAttributes<HTMLTextAreaElement>,'value'> & {value?:Value}) {
 const ref=useRef<HTMLTextAreaElement>(null);
 useLayoutEffect(()=>{const node=ref.current;if(node&&node.ownerDocument.activeElement!==node&&node.value!==String(value??''))node.value=String(value??'');});
 return <ReuiTextarea {...props} ref={ref} defaultValue={value??''}/>;
}
export function Select({value,...props}:Omit<SelectHTMLAttributes<HTMLSelectElement>,'value'> & {value?:Value}) {
 const ref=useRef<HTMLSelectElement>(null);
 useLayoutEffect(()=>{const node=ref.current;if(node&&node.ownerDocument.activeElement!==node&&node.value!==String(value??''))node.value=String(value??'');});
 const {size,...rest}=props;
 return size||props.multiple?<select {...props} ref={ref} defaultValue={value??''}/>:<NativeSelect {...rest} ref={ref} defaultValue={value??''}/>;
}
// 旧业务字段保持开放形状；投影模型不会复制或改变保存协议。
export type Row = Record<string,any>;
