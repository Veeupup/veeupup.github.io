var images = document.getElementsByTagName("img");
var loHref = window.location.href
let baseHref = loHref.substring(0,loHref.lastIndexOf("/")+1)
for (let i = 0; i <images.length; i++) {
    let executeNum = 0;
    let src = images[i]['src']
    let img = new Image();
    img.src = src
    img.onload= ()=> {
    }
    img.onerror= ()=> {
        executeNum ++ ;
        handAMark(src)
        if(executeNum>3){
            return;
        }
        let fileName = src.substring(src.lastIndexOf("/")+1);
        images[i].src= baseHref+fileName
    }
}

function  handAMark(src){
    var as = document.getElementsByClassName("fancybox");
    for (let i = 0; i <as.length; i++) {
        let executeNum = 0;
        let href = as[i]['href']
        if(href==src){
            let img = new Image();
            img.src = src

            img.onload= ()=> {
            }
            img.onerror= ()=> {
                executeNum ++ ;
                if(executeNum>3){
                    return;
                }
                let fileName = src.substring(src.lastIndexOf("/")+1);
                as[i].href= baseHref+fileName
            }
        }

    }

}

