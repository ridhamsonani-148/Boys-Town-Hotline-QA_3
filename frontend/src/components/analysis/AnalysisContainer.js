import { useState, useEffect } from 'react';
import './AnalysisContainer.css';
import { uploadService } from '../../services/uploadService';

const WestIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M7.5 2L3.5 6L7.5 10" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const ClipboardIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <path d="M14 2H12.5C12.1 0.8 11 0 9.7 0H8.3C7 0 5.9 0.8 5.5 2H4C2.9 2 2 2.9 2 4V16C2 17.1 2.9 18 4 18H14C15.1 18 16 17.1 16 16V4C16 2.9 15.1 2 14 2ZM9 1.5C9.3 1.5 9.5 1.7 9.5 2S9.3 2.5 9 2.5S8.5 2.3 8.5 2S8.7 1.5 9 1.5ZM14 16H4V4H5.5V3.5C5.5 3.2 5.7 3 6 3H12C12.3 3 12.5 3.2 12.5 3.5V4H14V16Z" fill="#000"/>
  </svg>
);

const ProcessingIcon = ({ className }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={`${className} spinning`}>
    <circle cx="10" cy="10" r="8" stroke="#124dac" strokeWidth="2" strokeDasharray="25 5" fill="none"/>
  </svg>
);

const CompletedIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <circle cx="10" cy="10" r="10" fill="#377d20"/>
    <path d="M6 10L8.5 12.5L14 7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const FailedIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <circle cx="10" cy="10" r="10" fill="#d12121"/>
    <path d="M7 7L13 13M13 7L7 13" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const LineIcon = () => (
  <svg width="100%" height="1" viewBox="0 0 100 1" fill="none">
    <line x1="0" y1="0.5" x2="100" y2="0.5" stroke="#e0e0e0"/>
  </svg>
);

const ThickLineIcon = () => (
  <svg width="100%" height="2" viewBox="0 0 100 2" fill="none">
    <line x1="0" y1="1" x2="100" y2="1" stroke="#ccc" strokeWidth="2"/>
  </svg>
);

function AnalysisContainer({ fileName, onBackToUpload }) {
  const [fileDetails, setFileDetails] = useState([]);
  const [analysisResults, setAnalysisResults] = useState(null);
  const [processingTextIndex, setProcessingTextIndex] = useState(0);
  
  const processingTexts = [
    'Uploaded Successfully',
    'Processing',
    'Transcribing',
    'Formatting',
    'Evaluating'
  ];

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

  useEffect(() => {
    const hasProcessingFiles = fileDetails.some(file => file.status === 'processing');
    if (!hasProcessingFiles) return;

    const interval = setInterval(() => {
      setProcessingTextIndex(prev => (prev + 1) % processingTexts.length);
    }, 48000);

    return () => clearInterval(interval);
  }, [fileDetails, processingTexts.length]);



  const getStatusDisplay = (status) => {
    switch(status) {
      case 'processing':
        return {
          icon: ProcessingIcon,
          text: processingTexts[processingTextIndex],
          color: '#124dac'
        };
      case 'completed':
        return {
          icon: CompletedIcon,
          text: 'Completed',
          color: '#377d20'
        };
      case 'failed':
        return {
          icon: FailedIcon,
          text: 'Failed',
          color: '#d12121'
        };
      default:
        return {
          icon: ProcessingIcon,
          text: processingTexts[processingTextIndex],
          color: '#124dac'
        };
    }
  };

  return (
    <div className="analysis-page">
      <div className="analysis-container">
        <div className="back-link" onClick={onBackToUpload}>
          <div className="back-icon">
            <WestIcon className="west-icon" />
          </div>
          <span>Back to Upload</span>
        </div>
        
        <div className="analysis-content">
        <div className="analysis-header">
          <div className="clipboard-icon">
            <ClipboardIcon className="clipboard-base" />
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
          
          <ThickLineIcon className="header-divider" />
          
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
                    const IconComponent = statusInfo.icon;
                    return (
                      <>
                        <IconComponent className="status-icon" />
                        <span style={{ color: statusInfo.color }}>{statusInfo.text}</span>
                      </>
                    );
                  })()} 
                </div>
              </div>
              <LineIcon className="row-divider" />
            </div>
          ))}
        </div>
        </div>
      </div>
    </div>
  );
}

export default AnalysisContainer;