"use client";

function download(blob: Blob, filename: string) {
  const url=URL.createObjectURL(blob); const anchor=document.createElement("a"); anchor.href=url; anchor.download=filename; anchor.click(); URL.revokeObjectURL(url);
}
function csvCell(value: string | number) {
  const raw=String(value); const safe=/^[=+\-@]/.test(raw) ? `'${raw}` : raw; return `"${safe.replaceAll('"','""')}"`;
}

function tableRows() {
  const table=[...document.querySelectorAll("table")].find((item) => item.textContent?.includes("Vendidos") && item.textContent?.includes("Cortesias") && item.textContent?.includes("Resultado"));
  if (!table) return [] as string[][];
  return [...table.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th,td")].map((cell,index) => { const text=cell.textContent?.trim()??""; return index===0?text.replace(/×$/," ").trim():text; }));
}

export function ComparisonExportButtons() {
  function exportCsv() {
    const lines=tableRows();
    download(new Blob(["\uFEFF"+lines.map((line) => line.map(csvCell).join(";")).join("\r\n")],{type:"text/csv;charset=utf-8"}),"comparativo-financeiro.csv");
  }
  async function exportExcel() {
    const rows=tableRows(); if(!rows.length) return; const ExcelJS=(await import("exceljs")).default; const workbook=new ExcelJS.Workbook(); const sheet=workbook.addWorksheet("Comparativo");
    sheet.addRows(rows); sheet.columns=[{width:42},{width:12},{width:12},{width:16},{width:16},{width:18},{width:16},{width:16}]; sheet.views=[{state:"frozen",ySplit:1}]; sheet.autoFilter={from:"A1",to:"H1"};
    sheet.getRow(1).eachCell((cell) => { cell.font={bold:true,color:{argb:"FFFFFFFF"}}; cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF047857"}}; });
    sheet.pageSetup={orientation:"landscape",paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0};
    const buffer=await workbook.xlsx.writeBuffer(); download(new Blob([buffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),"comparativo-financeiro.xlsx");
  }
  async function exportPdf() {
    const rows=tableRows(); if(rows.length<2)return; const {jsPDF}=await import("jspdf"); const pdf=new jsPDF({orientation:"landscape",unit:"mm",format:"a4"});
    const widths=[70,22,22,32,28,34,28,28]; const left=10; const drawHeader=()=>{pdf.setFillColor(4,120,87);pdf.rect(left,22,widths.reduce((a,b)=>a+b,0),9,"F");pdf.setTextColor(255,255,255);pdf.setFontSize(8);let x=left;rows[0].forEach((cell,index)=>{pdf.text(cell,x+2,28);x+=widths[index]??25;});pdf.setTextColor(31,41,55);};
    pdf.setTextColor(17,24,39);pdf.setFontSize(16);pdf.text("Comparativo financeiro",left,12);pdf.setFontSize(8);pdf.text(`Gerado em ${new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"medium",timeZone:"America/Sao_Paulo"}).format(new Date())}`,left,18);drawHeader();let y=35;
    for(const row of rows.slice(1)){const firstLines=pdf.splitTextToSize(row[0],widths[0]-4) as string[];const height=Math.max(9,firstLines.length*4+3);if(y+height>195){pdf.addPage("a4","landscape");drawHeader();y=35;}pdf.setDrawColor(226,232,240);pdf.rect(left,y-5,widths.reduce((a,b)=>a+b,0),height);let x=left;row.forEach((cell,index)=>{pdf.text(index===0?firstLines:[cell],x+2,y);x+=widths[index]??25;});y+=height;}
    const pages=pdf.getNumberOfPages();for(let page=1;page<=pages;page++){pdf.setPage(page);pdf.setFontSize(8);pdf.setTextColor(100,116,139);pdf.text(`Página ${page} de ${pages}`,277,202,{align:"right"});}pdf.save("comparativo-financeiro.pdf");
  }
  return <div className="flex flex-wrap gap-2"><button type="button" onClick={exportPdf} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Exportar PDF</button><button type="button" onClick={exportCsv} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Exportar CSV</button><button type="button" onClick={exportExcel} className="rounded-lg border border-emerald-500/50 px-3 py-2 text-sm text-emerald-200">Exportar Excel</button></div>;
}
