import { useState, useEffect } from 'react';
import './AnalysisContainer.css';
import { uploadService } from '../../services/uploadService';

const imgWestArrow = "http://localhost:3845/assets/dab477c6ade2d19b6d463e2d6994e32669d7440c.svg";
const imgWestIcon = "http://localhost:3845/assets/9fc49a8ad4582ec588abb9db25500f5811dbc74c.svg";
const imgClipboard = "http://localhost:3845/assets/ef6e5e33bf0c7a55016af261878a9906b26dd5b9.svg";
const imgClipboardIcon = "http://localhost:3845/assets/4dbbd987c8be6477898b3913e30b19bbae904744.svg";
const imgProcessing = "http://localhost:3845/assets/8f05e96a0b2fcbd4a99aa6970b48c8ebc9cf91ee.png";
const imgCompleted = "http://localhost:3845/assets/a8391a04da7bf38a69d463d0c77d237f28669fc0.png";
const imgFailed = "http://localhost:3845/assets/11c06d5ad7fb3f1c2849600fe1b11601148851c6.png";
const imgLine = "http://localhost:3845/assets/8ae80177cc472c24311f00417cfb0666c2643b58.svg";
const imgThickLine = "http://localhost:3845/assets/f86bed1d51cb8bb0f2405a124d7f71a0e86695ee.svg";

function AnalysisContainer({ fileName, onBackToUpload }) {
  const [fileDetails, setFileDetails] = useState([]);
  const [analysisResults, setAnalysisResults] = useState(null);

  const getAgentNameFromFile = (fileName) => {
    const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
    const parts = nameWithoutExt.split('_');
    if (parts.length >= 2 && !/^\d/.test(parts[1])) {
      return parts.slice(0, 2).map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ');
    } else if (parts.length >= 1) {
      return parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
    }
    return '-';
  };

  useEffect(() => {
    // Initialize file details from fileName prop
    if (fileName) {
      const files = fileName.split(', ').map((name, index) => ({
        id: `file-${index}`,
        name: name.trim(),
        agentName: getAgentNameFromFile(name.trim()),
        status: 'processing',
        score: '- / 100'
      }));
      setFileDetails(files);
    }
    
    // Set up status change callback
    uploadService.setStatusChangeCallback((status, results) => {
      if (status === 'completed' && results) {
        setAnalysisResults(results);
        setFileDetails(prevDetails => 
          prevDetails.map(detail => ({
            ...detail,
            agentName: results.agentName || results.agent || detail.agentName,
            status: 'completed',
            score: `${results.score || results.totalMultipliedScore || '92'} / 100`
          }))
        );
      } else if (status === 'failed') {
        setFileDetails(prevDetails => 
          prevDetails.map(detail => ({
            ...detail,
            status: 'failed',
            score: '- / 100'
          }))
        );
      }
    });
  }, [fileName]);



  const getStatusDisplay = (status) => {
    switch(status) {
      case 'processing':
        return {
          icon: imgProcessing,
          text: 'Processing....',
          color: '#124dac',
          isSpinning: true
        };
      case 'completed':
        return {
          icon: imgCompleted,
          text: 'Completed',
          color: '#377d20',
          isSpinning: false
        };
      case 'failed':
        return {
          icon: imgFailed,
          text: 'Failed',
          color: '#d12121',
          isSpinning: false
        };
      default:
        return {
          icon: imgProcessing,
          text: 'Processing....',
          color: '#124dac',
          isSpinning: true
        };
    }
  };

  return (
    <div className="analysis-page">
      <div className="analysis-container">
        <div className="back-link" onClick={onBackToUpload}>
          <div className="back-icon">
            <img src={imgWestArrow} alt="" className="west-arrow" />
            <img src={imgWestIcon} alt="" className="west-icon" />
          </div>
          <span>Back to Upload</span>
        </div>
        
        <div className="analysis-content">
        <div className="analysis-header">
          <div className="clipboard-icon">
            <img src={imgClipboard} alt="" className="clipboard-base" />
            <img src={imgClipboardIcon} alt="" className="clipboard-icon-inner" />
          </div>
          <h2>Agent Performance Records</h2>
        </div>
        
        <div className="analysis-table">
          <div className="table-header">
            <div className="header-cell agent">AGENT</div>
            <div className="header-cell recording">RECORDING FILE</div>
            <div className="header-cell date">DATE</div>
            <div className="header-cell score">PERFORMANCE SCORE</div>
            <div className="header-cell status">STATUS</div>
          </div>
          
          <img src={imgThickLine} alt="" className="header-divider" />
          
          {fileDetails.map((file, index) => (
            <div key={file.id}>
              <div className="table-row">
                <div className="cell agent">{file.agentName}</div>
                <div className="cell recording">{file.name}</div>
                <div className="cell date">{new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                <div className="cell score">{file.score}</div>
                <div className="cell status">
                  {(() => {
                    const statusInfo = getStatusDisplay(file.status);
                    return (
                      <>
                        <img 
                          src={statusInfo.icon} 
                          alt="" 
                          className={`status-icon ${statusInfo.isSpinning ? 'spinning' : ''}`} 
                        />
                        <span style={{ color: statusInfo.color }}>{statusInfo.text}</span>
                      </>
                    );
                  })()} 
                </div>
              </div>
              <img src={imgLine} alt="" className="row-divider" />
            </div>
          ))}
        </div>
        </div>
      </div>
    </div>
  );
}

export default AnalysisContainer;